#!/usr/bin/env python3
"""Ask a Jitsi Meet deployment for its room list over XMPP.

One XMPP websocket connection, one disco#items query to the conference
component. An empty answer means the server does not publish its rooms; an
error means the node is not served.

    python3 roomlist_probe.py wss://framatalk.org/xmpp-websocket framatalk.org
"""

import asyncio
import sys

sys.path[:0] = ["/data/pylibs", "/data/workspace/jitsi"]

from xmpp_ws import XmppWS  # noqa: E402


async def probe(url: str, domain: str) -> None:
    conf = f"conference.{domain}"
    c = XmppWS(url, domain)
    await c.connect()
    try:
        iq = (
            '<iq type="get" id="r" xmlns="jabber:client" '
            f'to="{conf}"><query '
            'xmlns="http://jabber.org/protocol/disco#items"/></iq>'
        )
        reply = await c.iq(iq)
        rooms = [i.get("jid") for i in reply.iter() if i.tag.endswith("item")]
        errors = [i.tag.split("}")[-1] for i in reply.iter() if i.tag.endswith("error")]
        print(f"{conf}: {len(rooms)} rooms, errors {errors or 'none'}")
        for jid in rooms:
            print(f"  {jid}")
    finally:
        await c.close()


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "wss://framatalk.org/xmpp-websocket"
    domain = sys.argv[2] if len(sys.argv) > 2 else "framatalk.org"
    loop = asyncio.new_event_loop()
    loop.run_until_complete(probe(url, domain))
