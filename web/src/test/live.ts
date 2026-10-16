import { HttpResponse, http } from "msw"

/** The ticket answer every test gets unless it brings its own handler: a new one for each ask. */
export function ticketHandler() {
  let issued = 0
  return http.post("/api/v1/models/:id/live/ticket", ({ params }) => {
    issued += 1
    return HttpResponse.json({
      ticket: `ticket-${issued}`,
      url: `ws://localhost/api/v1/models/${String(params.id)}/live`,
    })
  })
}

type Listener<E> = ((event: E) => void) | null

/** What a close event holds, as far as the live hook reads it. */
interface CloseEventInit {
  code: number
}

/**
 * A WebSocket that opens no connection. The setup file installs it for every test, so none reaches
 * a network; a test that follows a socket finds it in `FakeWebSocket.sockets` and plays the
 * server: `receive` sends it a message, `drop` ends it.
 */
export class FakeWebSocket {
  /** Every socket opened since the last test, oldest first. */
  static sockets: FakeWebSocket[] = []

  readonly url: string
  /** The code the page closed this socket with, if it did. */
  closedWith: number | undefined
  onmessage: Listener<MessageEvent<string>> = null
  onclose: Listener<CloseEventInit> = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.sockets.push(this)
  }

  /** The socket most recently opened. */
  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.sockets.at(-1)
    if (!socket) {
      throw new Error("No socket was opened.")
    }
    return socket
  }

  close(code = 1005) {
    this.closedWith = code
  }

  /** The server sends a JSON text frame. */
  receive(message: Record<string, unknown>) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }))
  }

  /** The server sends a frame as it is, such as one that is no JSON. */
  receiveText(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }))
  }

  /** The connection ends, as a refused or lost one does with code 1006. */
  drop(code = 1006) {
    this.onclose?.({ code })
  }
}

/** The socket a page opened: the server's greeting, with the model's last sequence number. */
export function hello(seq: number) {
  return { type: "hello", seq }
}
