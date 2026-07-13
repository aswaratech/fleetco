# ADR-0003: Trip as the central aggregate

- **Status:** Accepted
- **Date:** 2026-05-09
- **Decider:** Product owner (CEO)

## Context

A fleet ERP touches many concepts: vehicles, drivers, customers, jobs, fuel, expenses, maintenance, compliance, invoices, vendors, lease-takers, GPS data. We need a domain anchor — one entity that the rest hang off of — or the schema fragments and modules end up talking past each other. Without a clear central aggregate, every module invents its own view of how the world works, and those views inevitably conflict. The cost of that conflict shows up months later as compensating complexity that no one can untangle.

## Decision

The Trip is the central aggregate of the FleetCo domain. Every operational event of business value attaches to a Trip in some way. A Trip is one contiguous use of one Vehicle by one Driver for one Job, with a start odometer reading, an end odometer reading, a start time, an end time, and the route data accumulated during the trip (which becomes meaningful in Phase 2 when GPS streaming arrives). Fuel logs link to a Trip, or to a Vehicle for non-trip fuel events such as filling up between jobs. Driver compensation is computed from Trips. Customer revenue is invoiced from Trips on Jobs. Maintenance triggers are driven by Trip-accumulated kilometers and hours. GPS evidence belongs to a Trip. Expenses (toll, on-road repair, fines) link to a Trip or to a Vehicle. A Job groups Trips for a Customer; a Job is a contract, and the Trips are the executions of that contract. A Vehicle and a Driver are participants in Trips; their identities are independent of any single trip but their operational history is composed of trips.

## Alternatives considered

We could have made the Vehicle the central aggregate, with Trips as a property of the Vehicle's operational log. This works for vehicle-centric reports but fails for customer billing, where the natural unit is "what trips did we run for this customer" and traversing through Vehicles to get there is awkward. The Vehicle-centric model also makes lease-taker billing harder, because lease-takers operate vehicles for periods that may include many trips for many customers, and treating the Vehicle as primary forces us to express that as a sub-structure rather than as a peer relationship.

We could have made the Job the central aggregate, with Trips as the execution units. This works for customer-facing reports but fails for vehicle utilization analysis, where the natural question is "what was this vehicle doing across all jobs last month" and traversing through Jobs to answer it is expensive. The Job-centric model also breaks for in-house operations such as moving equipment between depots, which are operationally trips but commercially not jobs.

We could have refused to choose a central aggregate and built each module around its own central concept. This is what unstructured monoliths often end up with by accident. The result is that every cross-module question becomes an integration problem, and the schema accumulates compensating complexity to hold the modules together. We rejected this option because it produces exactly the rot we are using a modular monolith to avoid.

The Trip wins as the central aggregate because every other entity can be expressed naturally as a participant in or a consequence of trips. A Vehicle's monthly profit and loss is the sum of the revenue from its trips minus the sum of the costs of its trips. A Customer's bill is the sum of the trip-prices for trips on their job. A Driver's pay is computed from the trips they drove. Maintenance is triggered by trip-accumulated mileage. The model is natural in a way the alternatives are not.

## Consequences

The Trip schema gets more careful design attention than any other schema in the system, and we are willing to revisit and reshape it during Phase 1 if necessary. The Trip is also the first place we will ADR-revise if it turns out our model of trips is wrong. Modules naturally orient around the Trip lifecycle: events such as `TripStarted`, `TripEnded`, `TripCancelled` become the integration surface between modules. Reports are largely Trip aggregates over time, vehicle, driver, customer, and job dimensions. The reporting story becomes substantially simpler when the underlying domain has a clear spine.

The risk of this decision is that we will be tempted to force-fit non-trip events into the Trip model. For example, depot-based maintenance is not naturally a Trip; nor is overhead such as office expenses. We mitigate this risk by allowing Vehicle-level and global-level entries explicitly. Not everything is a Trip. Fuel can be vehicle-level (filling up between jobs without an active trip). Maintenance can be vehicle-level (annual servicing at the depot). Expenses can be vehicle-level (parking) or company-level (office rent in a future accounting phase). The Trip is central, but it is not exhaustive, and the schema admits non-trip events as first-class data rather than awkward Trip-shaped exceptions.

## Revisit when

The signal that would prompt revisiting this decision is the emergence of a business unit that does not naturally model as Trips, such as a workshop business that services outside customers' vehicles. If FleetCo grows beyond fleet operation into adjacent businesses, the Trip-as-central-aggregate decision may need to be reexamined for those parts of the business. For the operations FleetCo serves in v1 through Phase 5, the decision is stable.

---

**Annotation (2026-07-12, append-only):** **ADR-0047 extends this decision** by exercising the reshape it reserved here (*"the Trip is… the first place we will ADR-revise if it turns out our model of trips is wrong"*). ADR-0047 gives the central Trip a dispatch → acceptance lifecycle (`OFFERED`/`ACCEPTED` before `IN_PROGRESS`) and the **structured haulage order** — material, pinned pickup/drop-off `Site`s, consignee, and intra-load milestone timestamps — that this ADR always intended a Trip to carry as *"the execution of a Job's contract,"* but which had only ever existed as free text in `Job.description`. The Trip stays the central aggregate and the executor of a Job's work; the model is **completed, not replaced**. ADR-0047 deliberately does **not** build the `Trip → Job` link (still a deferred, ADR-0003-touching `docs/tech-debt.md` item) — the order attaches per-dispatch on the Trip — nor the distinct standing vehicle↔driver assignment. See **ADR-0047**.
