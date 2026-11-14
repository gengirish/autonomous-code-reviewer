package webhook

import (
	"testing"
	"time"
)

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		value  string
		want   time.Duration
		wantOK bool
	}{
		{"empty", "", 0, false},
		{"seconds", "120", 2 * time.Minute, true},
		{"seconds with spaces", " 5 ", 5 * time.Second, true},
		{"negative seconds", "-1", 0, false},
		{"huge seconds are capped", "99999999999", maxRetryAfter, true},
		{"http date in the future", "Sun, 01 Mar 2026 12:00:30 GMT", 30 * time.Second, true},
		{"http date in the past", "Sun, 01 Mar 2026 11:00:00 GMT", 0, true},
		{"http date far away is capped", "Mon, 02 Mar 2026 12:00:00 GMT", maxRetryAfter, true},
		{"garbage", "soon", 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseRetryAfter(tt.value, now)
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("parseRetryAfter(%q) = (%v, %v), want (%v, %v)", tt.value, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}
