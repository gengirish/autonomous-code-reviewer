package notify

import (
	"sort"
	"time"
)

// Event is a single activity item that can appear in a user's daily digest.
type Event struct {
	ID         string
	Kind       string
	Actor      string
	OccurredAt time.Time
}

// Digest groups a user's recent events by kind.
type Digest struct {
	GeneratedAt time.Time
	ByKind      map[string][]Event
	Total       int
}

// maxEventsPerKind keeps a noisy kind (for example "comment") from crowding out the rest.
const maxEventsPerKind = 20

// BuildDigest collects the events from the 24 hours before now, newest first, keeping at
// most maxEventsPerKind events of each kind.
func BuildDigest(events []Event, now time.Time) Digest {
	recent := filterOlderThan(events, now.Add(-24*time.Hour))
	sort.Slice(recent, func(i, j int) bool { return recent[i].OccurredAt.After(recent[j].OccurredAt) })

	d := Digest{GeneratedAt: now, ByKind: make(map[string][]Event)}
	for _, e := range recent {
		if len(d.ByKind[e.Kind]) >= maxEventsPerKind {
			continue
		}
		d.ByKind[e.Kind] = append(d.ByKind[e.Kind], e)
		d.Total++
	}
	return d
}

// filterOlderThan returns the events that occurred after cutoff.
func filterOlderThan(events []Event, cutoff time.Time) []Event {
	out := make([]Event, 0, len(events))
	for _, e := range events {
		if e.OccurredAt.After(cutoff) {
			out = append(out, e)
		}
	}
	return out
}

// dedupeByActor keeps the first event for each (kind, actor) pair.
func dedupeByActor(events []Event) []Event {
	seen := make(map[string]bool, len(events))
	out := events[:0]
	for _, e := range events {
		key := e.Kind + "|" + e.Actor
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, e)
	}
	return out
}
