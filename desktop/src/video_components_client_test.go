package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestComponentHostSamples(t *testing.T) {
	got := componentHostSamples([]string{
		"http://dw.mengxa.com/vc/manifest.json",
		"https://DW.Mengxa.com:8443/other.json",
		"not a url",
		"http://backup.test/m.json",
	})
	want := map[string]string{
		"dw.mengxa.com": "http://dw.mengxa.com/vc/manifest.json",
		"backup.test":   "http://backup.test/m.json",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("componentHostSamples() = %#v, want %#v", got, want)
	}
}

func TestOrderedComponentIPs(t *testing.T) {
	ips := []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"}
	results := map[string]componentProbeResult{
		"1.1.1.1": {Latency: 80 * time.Millisecond},
		"2.2.2.2": {Err: errors.New("HTTP 404")},
		"3.3.3.3": {Latency: 20 * time.Millisecond},
	}
	got := orderedComponentIPs(ips, results)
	want := []string{"3.3.3.3", "1.1.1.1", "2.2.2.2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("orderedComponentIPs() = %#v, want %#v", got, want)
	}
}

func TestUniqueStrings(t *testing.T) {
	got := uniqueStrings([]string{"a", "", "b", "a", "c"})
	want := []string{"a", "b", "c"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("uniqueStrings() = %#v, want %#v", got, want)
	}
}

// The URL points at an unreachable address, while DNS also returns the real
// server. If probing and pinning work, the client still reaches the server.
func TestComponentsDownloadClientPinsReachableNode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"version":"1.4.0","parts":[]}`)
	}))
	defer server.Close()
	host, port, err := serverAddrHostPort(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	deadHost := "127.0.0.2"

	originalLookup := componentLookupHost
	componentLookupHost = func(_ context.Context, name string) ([]string, error) {
		if name != deadHost {
			return nil, fmt.Errorf("unexpected lookup of %s", name)
		}
		// List the dead address first: DNS order must not decide the winner.
		return []string{deadHost, host}, nil
	}
	t.Cleanup(func() { componentLookupHost = originalLookup })

	var logs []string
	client := componentsDownloadClient(
		[]string{fmt.Sprintf("http://%s:%s/vc/manifest.json", deadHost, port)},
		func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) },
	)
	resp, err := client.Get(fmt.Sprintf("http://%s:%s/vc/manifest.json", deadHost, port))
	if err != nil {
		t.Fatalf("download through pinned client failed: %v (logs: %v)", err, logs)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected response: status=%d body=%q err=%v", resp.StatusCode, body, err)
	}
	if string(body) != `{"version":"1.4.0","parts":[]}` {
		t.Fatalf("unexpected body %q", body)
	}
	joined := strings.Join(logs, "\n")
	if !strings.Contains(joined, "probed "+deadHost) {
		t.Fatalf("probe result missing from log: %v", logs)
	}
}

func serverAddrHostPort(rawURL string) (string, string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" {
		return "", "", fmt.Errorf("unexpected test server URL %q: %v", rawURL, err)
	}
	return u.Hostname(), u.Port(), nil
}
