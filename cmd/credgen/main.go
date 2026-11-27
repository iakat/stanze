package main

import (
	"fmt"
	"os"
	"time"

	"github.com/pion/turn/v5"
)

func main() {
	secret := os.Args[1]
	ttl := 10 * time.Minute
	user, pass, err := turn.GenerateLongTermTURNRESTCredentials(secret, "probe", ttl)
	if err != nil {
		fmt.Println("ERR", err)
		return
	}
	fmt.Printf("USER=%s\nPASS=%s\n", user, pass)
}
