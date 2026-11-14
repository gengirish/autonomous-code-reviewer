package notify

import (
	"fmt"
	"testing"
	"time"
)

func TestBuildDigestKeepsOnlyTheLastDay(t *testing.T) {
	now := time.Date(2026, 5, 4, 8, 0, 0, 0, time.UTC)
	events := []Event{
		{ID: "old", Kind: "comment", Actor: "ana", OccurredAt: now.Add(-25 * time.Hour)},
		{ID: "new", Kind: "comment", Actor: "ben", OccurredAt: now.Add(-time.Hour)},
		{ID: "newer", Kind: "mention", Actor: "ana", OccurredAt: now.Add(-time.Minute)},
	}

	d := BuildDigest(events, now)

	if d.Total != 2 {
		t.Fatalf("Total = %d, want 2", d.Total)
	}
	if got := d.ByKind["comment"]; len(got) != 1 || got[0].ID != "new" {
		t.Fatalf("comments = %+v, want only the recent one", got)
	}
}

func TestBuildDigestCapsEventsPerKind(t *testing.T) {
	now := time.Date(2026, 5, 4, 8, 0, 0, 0, time.UTC)
	var events []Event
	for i := 0; i < maxEventsPerKind+5; i++ {
		events = append(events, Event{ID: fmt.Sprint(i), Kind: "comment", OccurredAt: now.Add(-time.Duration(i) * time.Minute)})
	}

	d := BuildDigest(events, now)

	if got := len(d.ByKind["comment"]); got != maxEventsPerKind {
		t.Fatalf("len(comments) = %d, want %d", got, maxEventsPerKind)
	}
	if d.ByKind["comment"][0].ID != "0" {
		t.Fatalf("first comment = %s, want the newest (0)", d.ByKind["comment"][0].ID)
	}
}
