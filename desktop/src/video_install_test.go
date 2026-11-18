package main

import (
	"reflect"
	"testing"
)

func TestManifestURLs(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want []string
	}{
		{
			name: "empty",
			raw:  "",
			want: nil,
		},
		{
			name: "single",
			raw:  "https://dl1.example.test/vc/manifest.json",
			want: []string{"https://dl1.example.test/vc/manifest.json"},
		},
		{
			name: "four nodes keep order",
			raw:  "https://dl1.example.test/m.json, https://dl2.example.test/m.json ,https://dl3.example.test/m.json,https://dl4.example.test/m.json",
			want: []string{
				"https://dl1.example.test/m.json",
				"https://dl2.example.test/m.json",
				"https://dl3.example.test/m.json",
				"https://dl4.example.test/m.json",
			},
		},
		{
			name: "drops invalid and duplicates",
			raw:  "javascript:alert(1),https://a.test/m.json,https://a.test/m.json,ftp://b.test/m.json,https://c.test/m.json",
			want: []string{"https://a.test/m.json", "https://c.test/m.json"},
		},
		{
			name: "lowercases scheme only, host preserved by url.Parse",
			raw:  "HTTPS://A.test/m.json",
			want: []string{"https://A.test/m.json"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := manifestURLs(tt.raw)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("manifestURLs(%q) = %#v, want %#v", tt.raw, got, tt.want)
			}
		})
	}
}
