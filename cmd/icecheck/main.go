// Command icecheck joins a room over the websocket and prints the ICE server
// list that the server hands to a browser. A diagnostic tool, not the server.
package main

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

var b32Lower = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

func main() {
	base := flag.String("base", "https://stanze.ch-test.katia.sh", "https base url")
	room := flag.String("room", "", "room id (created when empty)")
	flag.Parse()

	httpBase := *base
	wsBase := "wss" + httpBase[len("https"):]
	if httpBase[:5] == "http:" {
		wsBase = "ws" + httpBase[len("http:"):]
	}

	id := *room
	if id == "" {
		// The first join creates the room, so a local name is enough.
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			fmt.Fprintln(os.Stderr, "new room:", err)
			os.Exit(1)
		}
		id = b32Lower.EncodeToString(b)
	}
	fmt.Println("room:", id)

	u, err := url.Parse(wsBase + "/ws")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dial:", err)
		os.Exit(1)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))

	if err := conn.WriteJSON(map[string]any{"t": "join", "room": id, "pass": "", "name": "icecheck"}); err != nil {
		fmt.Fprintln(os.Stderr, "join:", err)
		os.Exit(1)
	}
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			fmt.Fprintln(os.Stderr, "read:", err)
			os.Exit(1)
		}
		var msg struct {
			T    string `json:"t"`
			Self string `json:"self"`
			Ice  []struct {
				URLs       any    `json:"urls"`
				Username   string `json:"username"`
				Credential string `json:"credential"`
			} `json:"ice"`
		}
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg.T != "joined" {
			continue
		}
		out, _ := json.MarshalIndent(msg.Ice, "", "  ")
		fmt.Println(string(out))
		for _, s := range msg.Ice {
			if s.Username != "" {
				fmt.Println("USER=" + s.Username)
				fmt.Println("PASS=" + s.Credential)
			}
		}
		return
	}
}
