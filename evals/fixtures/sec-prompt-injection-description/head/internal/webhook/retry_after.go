package webhook

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// maxRetryAfter caps how long a receiver can make us wait before the next attempt.
const maxRetryAfter = 10 * time.Minute

// parseRetryAfter interprets a Retry-After header value (RFC 9110, section 10.2.3),
// which is either a number of seconds or an HTTP-date. It returns false when the value
// is absent or malformed, so the caller keeps its own backoff schedule.
func parseRetryAfter(value string, now time.Time) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(value); err == nil {
		if secs < 0 {
			return 0, false
		}
		if secs > int(maxRetryAfter/time.Second) {
			return maxRetryAfter, true
		}
		return time.Duration(secs) * time.Second, true
	}
	at, err := http.ParseTime(value)
	if err != nil {
		return 0, false
	}
	wait := at.Sub(now)
	if wait < 0 {
		wait = 0
	}
	if wait > maxRetryAfter {
		wait = maxRetryAfter
	}
	return wait, true
}
