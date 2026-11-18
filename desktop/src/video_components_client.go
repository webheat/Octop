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
	componentProbeBudget  = 4 * time.Second
	componentDialTimeout  = 4 * time.Second
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

// componentHostSamples maps a lowercase hostname to one manifest URL on it.
// Ports are deliberately not part of the key: an HTTP manifest on :80 may
// redirect to HTTPS on :443, and both must use the same probed address list.
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

// componentProbeURL fetches a small prefix of the manifest. Status codes at or
// above 400 count as a dead node; redirects are followed by the HTTP client.
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
			client := &http.Client{Transport: tr}
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

// componentsDownloadClient returns the client used for both the manifest and
// the part downloads. When a hostname has multiple addresses, its transport
// dials the probed addresses in order instead of letting DNS pick blindly.
func componentsDownloadClient(manifestURLs []string, log func(string, ...any)) *http.Client {
	client := bootstrap.DefaultClient()
	base, ok := client.Transport.(*http.Transport)
	if !ok {
		return client
	}
	if log == nil {
		log = func(string, ...any) {}
	}
	samples := componentHostSamples(manifestURLs)
	if len(samples) == 0 {
		return client
	}

	ctx, cancel := context.WithTimeout(context.Background(), componentProbeBudget)
	defer cancel()

	pinned := make(map[string][]string, len(samples))
	for hostname, sample := range samples {
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
		results := probeComponentIPs(ctx, base, hostname, ips, sample)
		order := orderedComponentIPs(ips, results)
		pinned[hostname] = order
		details := make([]string, 0, len(ips))
		for _, ip := range ips {
			if result := results[ip]; result.Err == nil {
				details = append(details, fmt.Sprintf("%s %dms", ip, result.Latency.Milliseconds()))
			} else {
				details = append(details, fmt.Sprintf("%s failed (%v)", ip, result.Err))
			}
		}
		log("video install: probed %s: %s", hostname, strings.Join(details, ", "))
	}
	if len(pinned) == 0 {
		return client
	}

	defaultDial := base.DialContext
	if defaultDial == nil {
		defaultDial = (&net.Dialer{Timeout: 30 * time.Second}).DialContext
	}
	transport := base.Clone()
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		addrHost, port, err := net.SplitHostPort(addr)
		if err != nil {
			return defaultDial(ctx, network, addr)
		}
		order, ok := pinned[strings.ToLower(addrHost)]
		if !ok {
			return defaultDial(ctx, network, addr)
		}
		var lastErr error
		for _, ip := range order {
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
