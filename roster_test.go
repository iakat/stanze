package main

import (
	"encoding/json"
	"sort"
	"testing"
)

// The `joined` frame carries no roster, and this test is what keeps it that
// way. The security review found `serverMsg.Peers` declared and never filled
// while the client read it, so a future maintainer could have handed every page
// an unproven peer list with one line, and each page would have answered by
// sending its key bundle to ids nobody had confirmed.
//
// The field is gone from both sides. This pins the server half: the key set of
// a marshalled frame is exactly the six fields below, and no `peers` key can
// appear on it again without failing here first.
func TestJoinedFrameCarriesNoRoster(t *testing.T) {
	raw, err := json.Marshal(serverMsg{
		T:    "joined",
		Self: "abcdefabcdef",
		From: "abcdefabcdef",
		Code: "",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var frame map[string]json.RawMessage
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// `omitempty` keeps the empty fields out, so the set is a subset of the
	// allowed names rather than all of them. What matters is that nothing
	// outside the list is ever written.
	allowed := map[string]bool{
		"t":    true,
		"self": true,
		"peer": true,
		"from": true,
		"code": true,
		"ice":  true,
	}
	var names []string
	for name := range frame {
		names = append(names, name)
		if !allowed[name] {
			t.Errorf("the joined frame carries %q, which is not one of the six fields", name)
		}
	}
	sort.Strings(names)

	if _, ok := frame["peers"]; ok {
		t.Fatal("the joined frame carries a peers roster: the relay must never hand out an unproven peer list")
	}

	// A zero frame is the whole allowed set, so the check above is not
	// vacuously true on a message that wrote nothing.
	zero, err := json.Marshal(serverMsg{})
	if err != nil {
		t.Fatalf("marshal zero: %v", err)
	}
	var zeroFrame map[string]json.RawMessage
	if err := json.Unmarshal(zero, &zeroFrame); err != nil {
		t.Fatalf("unmarshal zero: %v", err)
	}
	// The zero frame writes the two fields that have no omitempty; everything
	// it writes must still be allowed.
	for name := range zeroFrame {
		if !allowed[name] {
			t.Errorf("a zero frame writes %q, which is not one of the six fields", name)
		}
	}
}
