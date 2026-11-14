package webhook

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"time"
)

// Dispatcher delivers webhook payloads with exponential backoff.
type Dispatcher struct {
	client      *http.Client
	maxAttempts int
	baseDelay   time.Duration
	sleep       func(context.Context, time.Duration) error
	now         func() time.Time
}

// NewDispatcher returns a Dispatcher with the production retry policy.
func NewDispatcher(client *http.Client) *Dispatcher {
	return &Dispatcher{
		client:      client,
		maxAttempts: 5,
		baseDelay:   500 * time.Millisecond,
		sleep:       sleepContext,
		now:         time.Now,
	}
}

// Deliver posts payload to url, retrying on 429 and 5xx responses. When the receiver
// sends Retry-After, the next attempt waits at least that long.
func (d *Dispatcher) Deliver(ctx context.Context, url string, payload []byte) error {
	var lastErr error
	var retryAfter time.Duration
	for attempt := 0; attempt < d.maxAttempts; attempt++ {
		if attempt > 0 {
			wait := d.backoff(attempt)
			if retryAfter > wait {
				wait = retryAfter
			}
			if err := d.sleep(ctx, wait); err != nil {
				return err
			}
		}
		retryAfter = 0
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
		if err != nil {
			return fmt.Errorf("build request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := d.client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		resp.Body.Close()
		if resp.StatusCode < 300 {
			return nil
		}
		lastErr = fmt.Errorf("receiver responded %d", resp.StatusCode)
		if resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < 500 {
			return lastErr
		}
		if wait, ok := parseRetryAfter(resp.Header.Get("Retry-After"), d.now()); ok {
			retryAfter = wait
		}
	}
	return fmt.Errorf("giving up after %d attempts: %w", d.maxAttempts, lastErr)
}

func (d *Dispatcher) backoff(attempt int) time.Duration {
	return d.baseDelay * time.Duration(1<<(attempt-1))
}

func sleepContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
