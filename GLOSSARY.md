# Scene Ready commons

The language Scene Ready apps share when they point at each other's records, call each other's APIs and tell each other about changes. Words for one app's own records belong in that app's glossary.

## Language

### Apps and records

**App**:
One Scene Ready product, identified by its app key. Auth and the Hub are Apps too.
_Avoid_: service, client, caller

**Record**:
A thing one App owns and other Apps may point at.
_Avoid_: entity, object, resource

**Record type**:
The kind of a Record, named in its Owner's vocabulary.
_Avoid_: entity type

**Owner**:
The App a Record belongs to. It also owns that Record's type, its Event types and the API that serves it.
_Avoid_: source (outside the envelope field), provider

**Reference**:
A pointer from one App to a Record another App owns. The pointer is kept, never a copy of the Record.
_Avoid_: link, foreign key, pointer, ref (in prose)

**Holder**:
An App that keeps a Reference to another App's Record.
_Avoid_: consumer, client, referrer

### Organizations and people

**Organization**:
The auth organization that a Record, an API call and an Event belong to.
_Avoid_: org (in prose), tenant, account

**Org relationship**:
A link between an App and an Organization, formed when one of the Organization's members first signs in through that App. An App may call APIs for, and receive Events about, only those Organizations.
_Avoid_: relationship (unqualified), access, connection

**Acting user**:
The person an action is credited to. It is absent when an App acts by itself.
_Avoid_: actor (outside the envelope field), initiator, caller

### Events

**Event**:
A hint that one Record changed. It names the Record but does not carry its state.
_Avoid_: notification, message, webhook, change event

**Hub**:
The one place every Event between Apps passes through; Apps never deliver Events to each other.
_Avoid_: broker, bus, router; "events Worker" only when talking about deployment

**Event type**:
The kind of an Event, including its major version, owned by one Owner.
_Avoid_: topic, event name

**Publisher**:
An Owner in its role of sending Events. It publishes only about Records it owns.
_Avoid_: producer, emitter

**Outbox**:
A Publisher's list of the Events it has not yet had acknowledged, written along with the change each one describes.
_Avoid_: queue, pending events

**Subscriber**:
An App in its role of receiving Events.
_Avoid_: receiver, consumer, listener

**Subscription**:
An App's single standing request for Events of certain types at its endpoint.
_Avoid_: webhook, registration

**Delivery**:
One Event on its way to one Subscription.
_Avoid_: webhook, message, notification

**Attempt**:
One signed send of a Delivery.
_Avoid_: retry (as a noun)

**Catch-up**:
A Subscriber reading back the Events its Subscription would have received.
_Avoid_: replay, backfill, resync

### This package

**Module**:
Code that two or more Apps use, holds no App's domain logic and keeps no state, published behind its own entry point.
_Avoid_: package, lib, library
