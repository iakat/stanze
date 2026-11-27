// Command relaydiag gathers ICE candidates through the deployed relay and
// prints them. A temporary diagnostic, not part of the server.
package main

import (
	"flag"
	"fmt"
	"time"

	"github.com/pion/webrtc/v4"
)

func main() {
	host := flag.String("host", "152.53.49.131:3478", "relay address")
	user := flag.String("user", "", "turn user")
	pass := flag.String("pass", "", "turn pass")
	flag.Parse()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:" + *host}},
			{URLs: []string{"turn:" + *host + "?transport=udp"}, Username: *user, Credential: *pass},
		},
		ICETransportPolicy: webrtc.ICETransportPolicyRelay,
	})
	if err != nil {
		fmt.Println("pc:", err)
		return
	}
	defer pc.Close()
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			fmt.Println("gathering done")
			return
		}
		fmt.Println("candidate:", c.ToJSON().Candidate)
	})
	if _, err := pc.CreateDataChannel("x", nil); err != nil {
		fmt.Println("dc:", err)
		return
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		fmt.Println("offer:", err)
		return
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		fmt.Println("sld:", err)
		return
	}
	time.Sleep(8 * time.Second)
	fmt.Println("gathering state:", pc.ICEGatheringState(), "signaling:", pc.SignalingState())
}
