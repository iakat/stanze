// Command turnprobe checks that an embedded TURN server really relays UDP
// between two allocations. It is a diagnostic tool, not part of the server.
package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/pion/turn/v5"
)

func main() {
	addr := flag.String("turn-addr", "127.0.0.1:3478", "TURN server address")
	user := flag.String("user", "", "ephemeral TURN username")
	pass := flag.String("pass", "", "ephemeral TURN password")
	realm := flag.String("realm", "stanze", "TURN realm")
	flag.Parse()

	if *user == "" || *pass == "" {
		fmt.Fprintln(os.Stderr, "need -user and -pass")
		os.Exit(2)
	}

	alloc := func(tag string) (*turn.Client, net.PacketConn) {
		sock, err := net.ListenPacket("udp4", "0.0.0.0:0")
		if err != nil {
			fmt.Printf("FAIL %s socket: %v\n", tag, err)
			os.Exit(1)
		}
		c, err := turn.NewClient(&turn.ClientConfig{
			STUNServerAddr: *addr,
			TURNServerAddr: *addr,
			Conn:           sock,
			Username:       *user,
			Password:       *pass,
			Realm:          *realm,
		})
		if err != nil {
			fmt.Printf("FAIL %s client: %v\n", tag, err)
			os.Exit(1)
		}
		if err := c.Listen(); err != nil {
			fmt.Printf("FAIL %s listen: %v\n", tag, err)
			os.Exit(1)
		}
		go func() {
			buf := make([]byte, 1600)
			for {
				n, from, err := sock.ReadFrom(buf)
				if err != nil {
					return
				}
				_, _ = c.HandleInbound(buf[:n], from)
			}
		}()
		conn, err := c.Allocate()
		if err != nil {
			fmt.Printf("FAIL %s allocate: %v\n", tag, err)
			os.Exit(1)
		}
		fmt.Printf("ok   %s relay %s\n", tag, conn.LocalAddr())
		return c, conn
	}

	ca, a := alloc("A")
	defer ca.Close()
	cb, b := alloc("B")
	defer cb.Close()

	permission := func(c *turn.Client, conn net.PacketConn, target net.Addr, tag string) {
		if err := c.CreatePermission(target); err != nil {
			fmt.Printf("FAIL %s permission to %s: %v\n", tag, target, err)
			os.Exit(1)
		}
		fmt.Printf("ok   %s permission to %s\n", tag, target)
	}
	permission(ca, a, b.LocalAddr(), "A")
	permission(cb, b, a.LocalAddr(), "B")

	// Listen on B's relay socket, then send from A's relay socket.
	got := make(chan string, 1)
	go func() {
		buf := make([]byte, 1500)
		b.SetReadDeadline(time.Now().Add(8 * time.Second))
		n, from, err := b.ReadFrom(buf)
		if err != nil {
			got <- "read: " + err.Error()
			return
		}
		got <- fmt.Sprintf("payload=%q from=%s", string(buf[:n]), from)
	}()

	if _, err := a.WriteTo([]byte("relay-probe"), b.LocalAddr()); err != nil {
		fmt.Printf("FAIL A write: %v\n", err)
		os.Exit(1)
	}
	select {
	case res := <-got:
		if len(res) >= 5 && res[:5] == "read:" {
			fmt.Printf("FAIL relay data: %s\n", res)
			os.Exit(1)
		}
		fmt.Printf("ok   relay data: %s\n", res)
	case <-time.After(9 * time.Second):
		fmt.Println("FAIL relay data: timeout")
		os.Exit(1)
	}

	fmt.Println("RESULT: PASS")

	// Second direction: a plain socket sends straight at A's relay port, the
	// way a browser sends its ICE checks to a peer's relay candidate.
	direct := make(chan string, 1)
	go func() {
		buf := make([]byte, 1500)
		a.SetReadDeadline(time.Now().Add(8 * time.Second))
		n, from, err := a.ReadFrom(buf)
		if err != nil {
			direct <- "read: " + err.Error()
			return
		}
		direct <- fmt.Sprintf("payload=%q from=%s", string(buf[:n]), from)
	}()
	plain, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		fmt.Printf("FAIL plain socket: %v\n", err)
		os.Exit(1)
	}
	defer plain.Close()
	if err := ca.CreatePermission(plain.LocalAddr()); err != nil {
		fmt.Printf("FAIL permission for plain socket: %v\n", err)
		os.Exit(1)
	}
	// A pod behind the cluster NAT leaves this host with the host address, so
	// allow that source as well; external clients do not need it.
	host, _, _ := net.SplitHostPort(*addr)
	if _, port, err := net.SplitHostPort(plain.LocalAddr().String()); err == nil {
		if alt, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(host, port)); err == nil {
			if err := ca.CreatePermission(alt); err == nil {
				fmt.Printf("note extra permission %s\n", alt)
			}
		}
	}
	if _, err := plain.WriteTo([]byte("direct-to-relay"), a.LocalAddr()); err != nil {
		fmt.Printf("FAIL plain write: %v\n", err)
		os.Exit(1)
	}
	select {
	case res := <-direct:
		if len(res) >= 5 && res[:5] == "read:" {
			fmt.Printf("FAIL direct to relay: %s\n", res)
			os.Exit(1)
		}
		fmt.Printf("ok   direct to relay: %s\n", res)
	case <-time.After(9 * time.Second):
		fmt.Println("FAIL direct to relay: timeout")
		os.Exit(1)
	}
	fmt.Println("RESULT: PASS (both directions)")
}
