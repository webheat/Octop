package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"octop.desktop/bootstrap"
)

// The component manifest may sit behind one DNS name with several A records.
// DNS round-robin alone cannot tell a dead node from a live one, so the shell
// probes every record once at install time and then pins new connections to
// the reachable nodes. The URL itself keeps the original hostname: changing
// it to an IP would break TLS SNI, certificate validation, and virtual-host
// routing on nginx.

const (
	componentProbeTimeout = 2500 * time.Millisecond
	// componentProbeBudget is the total time the probes may take. Every
	// scheme of a host is probed separately, so the budget has to cover
	// more than one round: a host reachable over both http and https needs
	// two rounds, and the second one must not be cut short by an exhausted
	// budget.
	componentProbeBudget = 12 * time.Second
	componentDialTimeout = 4 * time.Second
)

type componentProbeResult struct {
	Latency time.Duration
	Err     error
}

// componentLookupHost is a variable so tests can exercise the selection logic
// without depending on real DNS.
var componentLookupHost = func(ctx context.Context, host string) ([]string, error) {
	return net.DefaultResolver.LookupHost(ctx, host)
}

// componentHostSamples maps a lowercase hostname to one sample URL on it.
//
// A host may appear with more than one scheme. The schemes are probed
// separately: a node that serves the archive over plain HTTP but has no
// certificate for the domain (or a certificate that does not match) must
// not be written off as dead — it is one of the fastest nodes for the
// plain-HTTP URLs. The first URL of a host wins the sample slot; the extra
// schemes are collected in componentSchemeSamples.
func componentHostSamples(manifestURLs []string) map[string]string {
	samples := make(map[string]string)
	for _, raw := range manifestURLs {
		u, err := url.Parse(raw)
		if err != nil || u.Hostname() == "" {
			continue
		}
		name := strings.ToLower(u.Hostname())
		if _, exists := samples[name]; !exists {
			samples[name] = raw
		}
	}
	return samples
}

// componentSchemeSamples maps "host|scheme" to one sample URL on it.
func componentSchemeSamples(manifestURLs []string) map[string]string {
	samples := make(map[string]string)
	for _, raw := range manifestURLs {
		u, err := url.Parse(raw)
		if err != nil || u.Hostname() == "" {
			continue
		}
		name := strings.ToLower(u.Hostname()) + "|" + strings.ToLower(u.Scheme)
		if _, exists := samples[name]; !exists {
			samples[name] = raw
		}
	}
	return samples
}

// componentSamplePort returns the port a sample URL talks to. The port
// decides which nodes may be used: a node reachable on :80 says nothing
// about its TLS setup on :443.
func componentSamplePort(sample string) string {
	u, err := url.Parse(sample)
	if err != nil {
		return ""
	}
	if port := u.Port(); port != "" {
		return port
	}
	if strings.EqualFold(u.Scheme, "https") {
		return "443"
	}
	return "80"
}

// componentProbeURL fetches a small prefix of the manifest. Status codes at or
// above 400 count as a dead node.
//
// A redirect counts as a dead node for this scheme. The redirect is followed
// by the client, but the answer then comes from another machine — the probe
// would credit this node with a capability it does not have. A node whose
// plain-HTTP port only redirects to HTTPS is exactly that case: it looks
// healthy on :80 and then serves a redirect instead of the archive.
func componentProbeURL(ctx context.Context, client *http.Client, rawURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusMultipleChoices && resp.StatusCode < http.StatusBadRequest {
		return fmt.Errorf("HTTP %d (redirect)", resp.StatusCode)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusBadRequest {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	_, err = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return err
}

// probeComponentIPs checks all addresses of one host concurrently. Each probe
// pins its own transport to a single IP while leaving the request URL (and
// therefore SNI and Host) untouched.
func probeComponentIPs(ctx context.Context, base *http.Transport, hostname string, ips []string, sample string) map[string]componentProbeResult {
	results := make(map[string]componentProbeResult, len(ips))
	defaultDial := base.DialContext
	if defaultDial == nil {
		defaultDial = (&net.Dialer{Timeout: componentProbeTimeout}).DialContext
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, ip := range ips {
		ip := ip
		wg.Add(1)
		go func() {
			defer wg.Done()
			probeCtx, cancel := context.WithTimeout(ctx, componentProbeTimeout)
			defer cancel()
			tr := base.Clone()
			defer tr.CloseIdleConnections()
			dialer := &net.Dialer{Timeout: componentProbeTimeout}
			tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
				addrHost, port, err := net.SplitHostPort(addr)
				if err != nil || !strings.EqualFold(addrHost, hostname) {
					return defaultDial(ctx, network, addr)
				}
				return dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
			}
			// The probe must not follow redirects: the answer after a
			// redirect comes from another machine, and crediting this node
			// with it would send the download to a node that only
			// redirects.
			client := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			}}
			start := time.Now()
			err := componentProbeURL(probeCtx, client, sample)
			mu.Lock()
			results[ip] = componentProbeResult{Latency: time.Since(start), Err: err}
			mu.Unlock()
		}()
	}
	wg.Wait()
	return results
}

// orderedComponentIPs puts responsive addresses first (fastest first) and
// keeps the DNS order as a fallback tail. Failed addresses stay usable: a
// node may recover before the download finishes, and every bootstrap attempt
// opens a fresh connection that re-runs this order.
func orderedComponentIPs(ips []string, results map[string]componentProbeResult) []string {
	good := make([]string, 0, len(ips))
	bad := make([]string, 0, len(ips))
	for _, ip := range ips {
		if result, ok := results[ip]; ok && result.Err == nil {
			good = append(good, ip)
		} else {
			bad = append(bad, ip)
		}
	}
	sort.SliceStable(good, func(i, j int) bool {
		return results[good[i]].Latency < results[good[j]].Latency
	})
	return append(good, bad...)
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

// containsString reports whether values holds the given entry.
func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// componentsDownloadClient returns the client used for both the manifest and
// the part downloads. When a hostname has multiple addresses, its transport
// dials the probed addresses in order instead of letting DNS pick blindly.
//
// partURLs are the locations of the archives themselves. They are probed
// alongside the manifest URLs because the archives may live on another host
// than the manifest — a node that only serves the manifest is useless for
// the download, and a node that serves the archives must be pinned even when
// the manifest is fetched elsewhere.
func componentsDownloadClient(manifestURLs []string, log func(string, ...any), partURLs ...string) *http.Client {
	client := bootstrap.DefaultClient()
	base, ok := client.Transport.(*http.Transport)
	if !ok {
		return client
	}
	if log == nil {
		log = func(string, ...any) {}
	}
	// Everything that will be fetched goes into the probe set.
	allURLs := append(append([]string{}, manifestURLs...), partURLs...)
	samples := componentHostSamples(allURLs)
	if len(samples) == 0 {
		return client
	}

	ctx, cancel := context.WithTimeout(context.Background(), componentProbeBudget)
	defer cancel()

	// The scheme matters: a node can serve the plain-HTTP URL perfectly
	// while its TLS setup is broken (a missing or expired certificate for
	// the domain). Probing only the HTTPS variant would write off one of
	// the fastest nodes, so every (host, scheme) pair gets its own probe.
	schemeSamples := componentSchemeSamples(allURLs)

	pinned := make(map[string][]string, len(samples))
	// healthyOrder holds the nodes that answered a probe, per host and
	// port. The port matters: a node can serve the plain-HTTP URL perfectly
	// while its TLS setup is broken (no certificate for the domain), so the
	// nodes reachable on :80 must not be handed to a :443 connection — the
	// handshake would fail and the request would die. The round-robin dialer
	// prefers these; pinned keeps the full list so a failed node can still
	// be tried as a last resort.
	healthyOrder := make(map[string][]string, len(samples))
	for hostname := range samples {
		ips, err := componentLookupHost(ctx, hostname)
		if err != nil {
			log("video install: DNS lookup of %s failed: %v", hostname, err)
			continue
		}
		ips = uniqueStrings(ips)
		if len(ips) < 2 {
			// One address offers no alternative; keep the stock resolver.
			continue
		}
		// Probe every scheme this host is reachable under. The nodes are
		// kept per port, so an HTTP-only node never ends up on the list
		// used for HTTPS connections.
		merged := map[string]componentProbeResult{}
		healthyByPort := map[string][]string{}
		for key, schemeSample := range schemeSamples {
			if !strings.HasPrefix(key, hostname+"|") {
				continue
			}
			results := probeComponentIPs(ctx, base, hostname, ips, schemeSample)
			details := make([]string, 0, len(ips))
			healthy := make([]string, 0, len(ips))
			for _, ip := range ips {
				result, ok := results[ip]
				if !ok {
					continue
				}
				if previous, seen := merged[ip]; !seen || (previous.Err != nil && result.Err == nil) {
					merged[ip] = result
				}
				if result.Err == nil {
					healthy = append(healthy, ip)
					details = append(details, fmt.Sprintf("%s %dms", ip, result.Latency.Milliseconds()))
				} else {
					details = append(details, fmt.Sprintf("%s failed (%v)", ip, result.Err))
				}
			}
			if len(healthy) > 0 {
				port := componentSamplePort(schemeSample)
				healthyByPort[port] = healthy
			}
			log("video install: probed %s: %s", key, strings.Join(details, ", "))
		}
		order := orderedComponentIPs(ips, merged)
		pinned[hostname] = order
		for port, healthy := range healthyByPort {
			healthyOrder[hostname+"|"+port] = healthy
		}
	}
	if len(pinned) == 0 {
		return client
	}
	if len(healthyOrder) == 0 {
		// No node passed the probe. Fall back to the full list: the nodes may
		// have recovered since, and the ordered list still tries the fastest
		// ones first.
		log("video install: no node passed the probe, trying every address in turn")
	}

	defaultDial := base.DialContext
	if defaultDial == nil {
		defaultDial = (&net.Dialer{Timeout: 30 * time.Second}).DialContext
	}
	transport := base.Clone()
	// The healthy addresses are handed out round-robin instead of always
	// starting at the fastest one. A single download keeps using the best
	// node, but a parallel range download opens several connections at once
	// — round-robin spreads those connections over the independent nodes
	// instead of piling them onto one origin and hitting that machine's
	// bandwidth ceiling.
	//
	// The counter is per host and port: the HTTPS pool and the plain-HTTP
	// pool are different sets of nodes, and a shared counter would let the
	// two schemes steal each other's slots — the fastest node could end up
	// unused while the slow ones take every connection.
	var counterMu sync.Mutex
	counters := map[string]uint64{}
	nextSlot := func(key string, size int) int {
		counterMu.Lock()
		defer counterMu.Unlock()
		value := counters[key]
		counters[key] = value + 1
		return int(value % uint64(size))
	}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		addrHost, port, err := net.SplitHostPort(addr)
		if err != nil {
			return defaultDial(ctx, network, addr)
		}
		host := strings.ToLower(addrHost)
		order, ok := pinned[host]
		if !ok {
			return defaultDial(ctx, network, addr)
		}
		// Prefer the nodes that passed the probe on this very port. A node
		// that failed the probe may still accept the TCP connect while
		// failing the TLS handshake (an expired certificate), so picking it
		// would kill the request without a chance to fall back to the next
		// node. An HTTP-only node must not be picked for a :443 connection
		// either — its TLS setup was never verified.
		preferred := order
		portHealthy := false
		if healthy, ok := healthyOrder[host+"|"+port]; ok && len(healthy) > 0 {
			preferred = healthy
			portHealthy = true
		}
		// Start at a different node for every connection so parallel range
		// requests land on separate machines.
		start := nextSlot(host+"|"+port, len(preferred))
		candidates := make([]string, 0, len(preferred))
		for i := 0; i < len(preferred); i++ {
			candidates = append(candidates, preferred[(start+i)%len(preferred)])
		}
		if !portHealthy {
			// No node was verified on this port. Try the remaining
			// addresses anyway — they may have recovered — but only after
			// the ones that did answer.
			for _, ip := range order {
				if !containsString(preferred, ip) {
					candidates = append(candidates, ip)
				}
			}
		}
		var lastErr error
		for _, ip := range candidates {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			dialer := &net.Dialer{Timeout: componentDialTimeout}
			conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
		}
		return nil, lastErr
	}
	client.Transport = transport
	return client
}
