import { setupServer } from "msw/node"
import { ticketHandler } from "./live"

// A model's screens open a live socket, which starts with a ticket; the setup file puts a fake in
// place of the socket, so every test answers the ticket and none reaches a network.
export const server = setupServer(ticketHandler())
