# Support Triage Assistant

A short brief for a small internal tool that helps a support team sort incoming
messages and hand each one to the right queue.

## Problem

The support team reads every incoming message by hand to decide which product
area it belongs to. As message volume grows the overnight queue backs up and the
first reply of the day arrives late. The team wants the sorting step to happen
before a message reaches a person.

## Goals

- Route each incoming message to one product area without human effort.
- Keep the median hand-off time under one minute on a normal working day.
- Leave a record of why a message was routed the way it was.

## Non-goals

- Replying to messages on behalf of the team.
- Replacing the ticketing system the team already uses.
- Predicting how long a reply will take.

## Functional requirements

1. The service shall accept messages from the ticketing system's webhook.
2. The service shall classify each message into one product area from a fixed
   list.
3. The review page shall show the classification and a short reason beside the
   ticket.
4. A person shall be able to correct the routing in one action.

## Non-functional requirements

- Classification within ten seconds of arrival.
- Up to 2,000 messages in a day without a backlog.
- Message content stays inside the team's own network.
- A restart does not lose a message that is still in flight.

## Inputs available today

The ticketing system sends a JSON body carrying a message identifier, the
sender's address, a subject line and the message body as plain text. No
attachment is sent with the message.

## Technical constraints

The team already runs a Node service and a PostgreSQL database on a single host,
and would prefer the new tool to sit beside them rather than on new
infrastructure.

## Deliverables

- A service that receives webhooks and records classifications.
- A page where the team reviews one day of routing decisions.

## Acceptance criteria

- Every message that arrives receives exactly one product area.
- A corrected routing is not overwritten by a later automatic pass.
- The review page shows the same decision the ticket shows.

## Open questions

### Retention period

### Budget owner

### Rollout order
