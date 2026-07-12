import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Button,
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  acceptTrip,
  ApiError,
  createFuelLog,
  listMyTrips,
  patchTrip,
  patchTripMilestone,
  routePreview,
} from "./src/api";
import { authClient } from "./src/auth";
import { fuelLogPayload, previewTotalCostPaisa } from "./src/fuel";
import { reconcileTripGps, startTripGps, stopTripGps } from "./src/gps-task";
import { formatEtaLabel, type RoutePreviewResult } from "./src/routing";
import { consumeSessionExpired } from "./src/session-expired";
import { TripMap } from "./src/trip-map";
import {
  isStartable,
  isStoppable,
  MATERIAL_TYPE_LABELS,
  meterIncludesHours,
  meterIncludesOdometer,
  milestonePayload,
  milestoneSteps,
  navigateUrl,
  tripStartPayload,
  tripStopPayload,
  TRIP_STATUS_LABELS,
  type DriverSite,
  type DriverTrip,
  type MilestoneField,
  type MilestoneStep,
  type TripReadings,
} from "./src/trips";

// A signed-in driver works across three tabs — accept dispatched trips
// (Requests, ADR-0047 W7), start/stop their OWN trips (Trips, D2), and log a
// fuel fill + odometer reading against one of those trips (Log fuel, D3). A
// lightweight in-app toggle switches between them (no navigation library yet —
// the app stays a single conditional tree). When unauthenticated, show the
// login form (D1). GPS capture runs while a trip is IN_PROGRESS (D4+).
export default function App() {
  const { data: session, isPending } = authClient.useSession();

  let body;
  if (isPending) {
    body = <ActivityIndicator accessibilityLabel="Loading" />;
  } else if (session) {
    body = <HomeScreen email={session.user.email} role={session.user.role} />;
  } else {
    body = <LoginForm />;
  }

  return (
    <View style={styles.container}>
      {body}
      <StatusBar style="auto" />
    </View>
  );
}

// One segmented-control tab. Extracted so the three-tab row (ADR-0047 W7 added
// Requests beside Trips / Log fuel) stays a single source of styling rather than
// three copies. Same Pressable + [base, active && activeStyle] idiom as before.
function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.tab, active && styles.tabActive]} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

// The signed-in shell: a shared header, a Requests / Trips / Log fuel toggle, the
// active screen, and sign-out. The toggle is a segmented control (three buttons
// since ADR-0047 W7); there is no navigation library yet, so the app stays a
// single conditional tree. Requests is the leftmost tab (the dispatch inbox); the
// default landing stays Trips so a driver's active work is unchanged on open.
function HomeScreen({ email, role }: { email: string; role?: string | null }) {
  const [screen, setScreen] = useState<"requests" | "trips" | "fuel">("trips");

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>FleetCo Driver</Text>
      <Text style={styles.email}>{email}</Text>
      <Text style={styles.role}>{role ?? "—"}</Text>

      <View style={styles.tabs}>
        <TabButton
          label="Requests"
          active={screen === "requests"}
          onPress={() => setScreen("requests")}
        />
        <TabButton label="Trips" active={screen === "trips"} onPress={() => setScreen("trips")} />
        <TabButton label="Log fuel" active={screen === "fuel"} onPress={() => setScreen("fuel")} />
      </View>

      {screen === "requests" ? (
        <RequestScreen />
      ) : screen === "trips" ? (
        <TripScreen />
      ) : (
        <FuelScreen />
      )}

      <Button title="Sign out" onPress={() => void authClient.signOut()} />
    </View>
  );
}

function TripScreen() {
  const [trips, setTrips] = useState<DriverTrip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  // Which trip's order-detail view is open (ADR-0047 W7) — null = the list. A
  // driver opens an accepted/active trip's detail to Navigate to the pins.
  const [detailId, setDetailId] = useState<string | null>(null);

  // Initial load on mount: the fetch + setState live in the promise continuation
  // (never synchronously in the effect body), and the `active` flag drops a late
  // response that resolves after unmount. The loaded list also feeds the D4
  // GPS self-heal (capture restarted after an app relaunch mid-trip; stopped if
  // the trip ended elsewhere) — a native call, not a setState, so it rides the
  // same continuation without tripping the set-state-in-effect rule.
  useEffect(() => {
    let active = true;
    listMyTrips()
      .then((items) => {
        if (active) setTrips(items);
        void reconcileTripGps(items);
      })
      .catch(() => {
        if (active) {
          setTrips([]);
          setError("Could not load your trips.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  // Start / stop, then refresh the list. Runs from an onPress handler (not an
  // effect), so these are ordinary event-driven state updates. `readings` carries
  // the meter reading(s) the vehicle calls for (ADR-0036) — km, hours, or both.
  //
  // D4 GPS ordering is load-bearing against the server's own-trip predicate
  // (pings are accepted only while the trip is IN_PROGRESS): on START the trip
  // is patched first, then capture begins; on STOP capture is drained FIRST
  // (the final flush must still target an IN_PROGRESS trip), then the patch
  // completes it. A capture problem never blocks the trip action — denial or
  // an unavailable runtime degrades to an honest note (ADR-0035 c1
  // best-effort posture).
  const transition = useCallback(
    async (trip: DriverTrip, readings: TripReadings, kind: "start" | "stop") => {
      setBusyId(trip.id);
      setError(null);
      setGpsNote(null);
      try {
        const nowIso = new Date().toISOString();
        if (kind === "stop") {
          await stopTripGps();
        }
        const payload =
          kind === "start"
            ? tripStartPayload(readings, nowIso)
            : tripStopPayload(readings, nowIso);
        await patchTrip(trip.id, payload);
        if (kind === "start") {
          const gps = await startTripGps({ tripId: trip.id, vehicleId: trip.vehicle.id });
          if (gps === "denied") {
            setGpsNote(
              "Trip started. GPS capture is off — allow location access to record the route.",
            );
          } else if (gps === "unavailable") {
            setGpsNote(
              "Trip started. GPS capture needs the dev build (not Expo Go) — see dev-setup.md.",
            );
          }
          // "started" is the silent happy path — the app is visibly open and
          // capturing (ADR-0035 c8's foreground-only D4 window).
        }
        setTrips(await listMyTrips());
      } catch {
        setError(kind === "start" ? "Could not start the trip." : "Could not end the trip.");
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  // A live-progress tap (ADR-0047 c8, W8): stamp one milestone timestamp on the
  // driver's own IN_PROGRESS trip and refresh, so the detail view re-renders the
  // row as done (a timestamp, not a toggle). Event-driven (an onPress handler),
  // so these setStates are unconstrained. No status change; the server enforces
  // the monotonic order, and its rejection message surfaces via ApiError.
  const markMilestone = useCallback(async (trip: DriverTrip, field: MilestoneField) => {
    setBusyId(trip.id);
    setError(null);
    setGpsNote(null);
    try {
      await patchTripMilestone(trip.id, milestonePayload(field, new Date().toISOString()));
      setTrips(await listMyTrips());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not update progress.");
    } finally {
      setBusyId(null);
    }
  }, []);

  // An open order-detail view replaces the list (no nav library — a local
  // conditional, same idiom as the tab shell). Refetches on start/stop/progress
  // keep the same trip id, so the detail view stays in sync with the row.
  const detailTrip = trips?.find((trip) => trip.id === detailId) ?? null;
  if (detailTrip) {
    return (
      <OrderDetail
        trip={detailTrip}
        onBack={() => setDetailId(null)}
        onProgress={(field) => void markMilestone(detailTrip, field)}
        progressBusy={busyId === detailTrip.id}
        actionError={error}
      />
    );
  }

  return (
    <View style={styles.subScreen}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {gpsNote ? <Text style={styles.empty}>{gpsNote}</Text> : null}

      {trips === null ? (
        <ActivityIndicator accessibilityLabel="Loading trips" style={styles.loading} />
      ) : trips.length === 0 ? (
        <Text style={styles.empty}>No trips assigned.</Text>
      ) : (
        <FlatList
          style={styles.list}
          data={trips}
          keyExtractor={(trip) => trip.id}
          renderItem={({ item }) => (
            <TripRow
              trip={item}
              busy={busyId === item.id}
              onStart={(readings) => void transition(item, readings, "start")}
              onStop={(readings) => void transition(item, readings, "stop")}
              onOpenDetail={() => setDetailId(item.id)}
            />
          )}
        />
      )}
    </View>
  );
}

function TripRow({
  trip,
  busy,
  onStart,
  onStop,
  onOpenDetail,
}: {
  trip: DriverTrip;
  busy: boolean;
  onStart: (readings: TripReadings) => void;
  onStop: (readings: TripReadings) => void;
  onOpenDetail: () => void;
}) {
  const [odometer, setOdometer] = useState("");
  const [hours, setHours] = useState("");
  const startable = isStartable(trip);
  const stoppable = isStoppable(trip);
  // A dispatched trip (ADR-0047) carries an order — surface a link into its
  // order-detail view (material, pins, Navigate, consignee). A legacy/PLANNED
  // trip with no order shows no link.
  const hasOrder =
    trip.materialType !== null || trip.pickupSite !== null || trip.dropoffSite !== null;

  // Meter-aware capture (ADR-0036 c7): prompt for the reading(s) the vehicle's
  // meter calls for — km for ODOMETER_KM, engine-hours for ENGINE_HOURS, both
  // for BOTH. A shown reading is required (the API rejects a missing one).
  const showOdometer = meterIncludesOdometer(trip.vehicle.meterType);
  const showHours = meterIncludesHours(trip.vehicle.meterType);

  const km = Number.parseInt(odometer, 10);
  const odometerOk = !showOdometer || (odometer.trim() !== "" && Number.isFinite(km) && km >= 0);
  const hoursNum = Number(hours);
  const hoursOk = !showHours || (hours.trim() !== "" && Number.isFinite(hoursNum) && hoursNum >= 0);
  const readingsValid = odometerOk && hoursOk;

  function buildReadings(): TripReadings {
    const readings: TripReadings = {};
    if (showOdometer) readings.odometerKm = km;
    if (showHours) readings.engineHours = hoursNum;
    return readings;
  }

  return (
    <View style={styles.tripRow}>
      <View style={styles.tripHeader}>
        <Text style={styles.tripReg}>{trip.vehicle.registrationNumber}</Text>
        <Text style={styles.tripStatus}>{trip.status}</Text>
      </View>
      {hasOrder ? (
        <Pressable onPress={onOpenDetail} accessibilityRole="button">
          <Text style={styles.viewOrderLink}>View order →</Text>
        </Pressable>
      ) : null}
      {startable || stoppable ? (
        <View style={styles.tripActions}>
          {showOdometer ? (
            <TextInput
              style={styles.reading}
              placeholder="Odometer (km)"
              keyboardType="number-pad"
              value={odometer}
              onChangeText={setOdometer}
              editable={!busy}
            />
          ) : null}
          {showHours ? (
            <TextInput
              style={styles.reading}
              placeholder="Engine hours"
              keyboardType="decimal-pad"
              value={hours}
              onChangeText={setHours}
              editable={!busy}
            />
          ) : null}
          <Button
            title={busy ? "…" : startable ? "Start trip" : "End trip"}
            disabled={busy || !readingsValid}
            onPress={() => (startable ? onStart(buildReadings()) : onStop(buildReadings()))}
          />
        </View>
      ) : null}
    </View>
  );
}

// ── Dispatch: the Requests tab + order-detail view (ADR-0047 W7) ──────────────

// Card + detail display helpers. materialLabel renders the enum label (with the
// free-text note appended when the material is OTHER); routeLabel renders
// "Pickup → Drop-off" from the Site names, an em-dash where an endpoint is unset.
function materialLabel(trip: DriverTrip): string {
  if (!trip.materialType) return "—";
  const label = MATERIAL_TYPE_LABELS[trip.materialType];
  return trip.materialType === "OTHER" && trip.materialNote
    ? `${label} · ${trip.materialNote}`
    : label;
}

function siteName(site: DriverSite | null): string {
  return site?.name ?? "—";
}

function routeLabel(trip: DriverTrip): string {
  return `${siteName(trip.pickupSite)} → ${siteName(trip.dropoffSite)}`;
}

// Hand a pin's coordinates to the device's Google Maps for turn-by-turn
// (ADR-0047 c9). No-ops on a missing pin (defensive — an OFFERED trip always
// carries both). Linking.openURL is fire-and-forget: a device with no maps app
// is a non-fatal no-op, not worth interrupting the primary flow with a banner.
function openNavigate(site: DriverSite | null): void {
  if (!site) return;
  void Linking.openURL(navigateUrl(site.latitude, site.longitude));
}

// A done milestone's stamped time as device-local HH:MM (ADR-0047 c8 — "a
// timestamp, not a toggle"). Device-local is the driver's own Nepal time; this
// is a TIME-OF-DAY, not a calendar date, so no Bikram Sambat rendering is
// involved (BS governs Y/M/D dates; a same-haul progress clock does not). Returns
// "" for a null/invalid stamp so the row degrades quietly.
function formatClock(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// The Requests tab (ADR-0047 c8): the driver's OFFERED trips as cards, each with
// an Accept action and a tap into the order-detail view. Accepting
// (OFFERED → ACCEPTED) moves the trip to the Trips tab as startable; there is no
// in-app decline (c2). The mount fetch keeps setState in the promise
// continuation guarded by `active` (the expo-SDK56 set-state-in-effect rule);
// the Accept handler is event-driven, so its setState calls are unconstrained.
function RequestScreen() {
  const [requests, setRequests] = useState<DriverTrip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listMyTrips({ status: "OFFERED" })
      .then((items) => {
        if (active) setRequests(items);
      })
      .catch(() => {
        if (active) {
          setRequests([]);
          setError("Could not load your requests.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setRequests(await listMyTrips({ status: "OFFERED" }));
    } catch {
      setRequests([]);
      setError("Could not load your requests.");
    }
  }, []);

  const accept = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      setNotice(null);
      try {
        await acceptTrip(id);
        setDetailId(null); // the accepted trip is no longer OFFERED — drop the detail
        setNotice("Trip accepted.");
        await refresh();
      } catch (e) {
        // Surface the API's OWN reason (a reassigned/withdrawn trip 400/403/404s).
        setError(e instanceof ApiError ? e.message : "Could not accept the trip.");
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const detailTrip = requests?.find((trip) => trip.id === detailId) ?? null;
  if (detailTrip) {
    return (
      <OrderDetail
        trip={detailTrip}
        onBack={() => setDetailId(null)}
        onAccept={(id) => void accept(id)}
        accepting={busyId === detailTrip.id}
        actionError={error}
      />
    );
  }

  return (
    <View style={styles.subScreen}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.success}>{notice}</Text> : null}

      {requests === null ? (
        <ActivityIndicator accessibilityLabel="Loading requests" style={styles.loading} />
      ) : requests.length === 0 ? (
        <Text style={styles.empty}>No new requests.</Text>
      ) : (
        <FlatList
          style={styles.list}
          data={requests}
          keyExtractor={(trip) => trip.id}
          renderItem={({ item }) => (
            <RequestCard
              trip={item}
              busy={busyId === item.id}
              onOpen={() => setDetailId(item.id)}
              onAccept={() => void accept(item.id)}
            />
          )}
        />
      )}
    </View>
  );
}

// One OFFERED trip in the Requests list: registration · material · route
// (ADR-0047 c8 / DESIGN §"Trip dispatch"). Tapping the card opens the order-
// detail view; the Accept button acts inline. A Button nested in the Pressable
// captures its own touch, so Accept accepts and the card body opens the detail.
function RequestCard({
  trip,
  busy,
  onOpen,
  onAccept,
}: {
  trip: DriverTrip;
  busy: boolean;
  onOpen: () => void;
  onAccept: () => void;
}) {
  return (
    <Pressable style={styles.tripRow} onPress={onOpen}>
      <View style={styles.tripHeader}>
        <Text style={styles.tripReg}>{trip.vehicle.registrationNumber}</Text>
        <Text style={styles.tripStatus}>{materialLabel(trip)}</Text>
      </View>
      <Text style={styles.orderRoute}>{routeLabel(trip)}</Text>
      <Button title={busy ? "…" : "Accept"} onPress={onAccept} disabled={busy} />
    </Pressable>
  );
}

// The order-detail view (ADR-0047 c8/c9/c10). Reached from a request card or an
// accepted/active trip row. Renders the haulage order in the DESIGN.md field
// order — material, pickup/drop-off (as pins on an inline map with a route +
// ETA preview, W8), a prominent Navigate button (Google Maps deep-link, c9), the
// consignee as a tap-to-call row (tel:; Tier-2 PII, never a log line or URL
// param — c6), load count, instructions, docket. While the trip is IN_PROGRESS
// it shows the live progress taps (W8). onAccept is supplied only for an OFFERED
// trip (the Requests flow); onProgress only for an active trip (the Trips flow).
function OrderDetail({
  trip,
  onBack,
  onAccept,
  accepting,
  actionError,
  onProgress,
  progressBusy,
}: {
  trip: DriverTrip;
  onBack: () => void;
  onAccept?: (id: string) => void;
  accepting?: boolean;
  actionError?: string | null;
  onProgress?: (field: MilestoneField) => void;
  progressBusy?: boolean;
}) {
  // A narrowed const so the tap-to-call closure captures a non-null phone (a
  // bare property access would not narrow into the closure — and must never
  // build "tel:null"). Same narrowing for the two pins, which the map needs
  // non-null.
  const phone = trip.consigneePhone;
  const pickup = trip.pickupSite;
  const dropoff = trip.dropoffSite;

  // Route/ETA preview for the inline map (ADR-0047 c9). Best-effort: a failed or
  // absent preview leaves the pins WITHOUT a route line (never an error). The
  // fetch + setState live in the promise continuation guarded by `active` (the
  // expo-SDK56 set-state-in-effect rule), dropping a response that resolves after
  // the detail view closes.
  const [route, setRoute] = useState<RoutePreviewResult | null>(null);
  useEffect(() => {
    if (!pickup || !dropoff) return;
    let active = true;
    routePreview(pickup, dropoff)
      .then((r) => {
        if (active) setRoute(r);
      })
      .catch(() => {
        if (active) setRoute(null);
      });
    return () => {
      active = false;
    };
  }, [pickup, dropoff]);

  // The live progress checklist shows only while the trip is running (ADR-0047
  // c8). offeredAt/acceptedAt were server-stamped earlier; these four are the
  // driver's taps.
  const steps = trip.status === "IN_PROGRESS" ? milestoneSteps(trip) : null;

  return (
    <ScrollView style={styles.subScreen} contentContainerStyle={styles.fuelContent}>
      <Pressable onPress={onBack} style={styles.backLink}>
        <Text style={styles.backLinkText}>‹ Back</Text>
      </Pressable>

      <View style={styles.tripHeader}>
        <Text style={styles.tripReg}>{trip.vehicle.registrationNumber}</Text>
        <Text style={styles.tripStatus}>{TRIP_STATUS_LABELS[trip.status]}</Text>
      </View>

      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}

      <Text style={styles.label}>Material</Text>
      <Text style={styles.detailValue}>{materialLabel(trip)}</Text>

      <Text style={styles.label}>Pickup</Text>
      <Text style={styles.detailValue}>{siteName(pickup)}</Text>
      <Text style={styles.label}>Drop-off</Text>
      <Text style={styles.detailValue}>{siteName(dropoff)}</Text>

      {pickup && dropoff ? (
        <>
          <TripMap
            pickup={pickup}
            dropoff={dropoff}
            routeGeometryLatLng={route ? route.geometryLatLng : null}
          />
          {route ? (
            <Text style={styles.etaLabel}>
              {formatEtaLabel(route.distanceMeters, route.durationSeconds)}
            </Text>
          ) : null}
        </>
      ) : null}

      {pickup ? <Button title="Navigate to pickup" onPress={() => openNavigate(pickup)} /> : null}
      {dropoff ? (
        <Button title="Navigate to drop-off" onPress={() => openNavigate(dropoff)} />
      ) : null}

      <Text style={styles.label}>Consignee</Text>
      <Text style={styles.detailValue}>{trip.consigneeName ?? "—"}</Text>
      {phone ? (
        <Pressable onPress={() => void Linking.openURL(`tel:${phone}`)}>
          <Text style={styles.callLink}>Call {phone}</Text>
        </Pressable>
      ) : null}

      <Text style={styles.label}>Expected load count</Text>
      <Text style={styles.detailValue}>{trip.expectedLoadCount ?? "—"}</Text>

      <Text style={styles.label}>Special instructions</Text>
      <Text style={styles.detailValue}>{trip.specialInstructions ?? "—"}</Text>

      <Text style={styles.label}>Docket</Text>
      <Text style={styles.detailValue}>{trip.docketNumber ?? "—"}</Text>

      {steps ? (
        <View style={styles.progress}>
          <Text style={styles.progressTitle}>Progress</Text>
          {steps.map((step) => (
            <ProgressRow
              key={step.field}
              step={step}
              busy={progressBusy ?? false}
              onMark={onProgress ? () => onProgress(step.field) : undefined}
            />
          ))}
        </View>
      ) : null}

      {onAccept && trip.status === "OFFERED" ? (
        <Button
          title={accepting ? "…" : "Accept"}
          onPress={() => onAccept(trip.id)}
          disabled={accepting}
        />
      ) : null}
    </ScrollView>
  );
}

// One live-progress milestone row (ADR-0047 c8, W8; DESIGN §"Trip dispatch"). A
// done milestone reads as its done label + the stamped clock time (a timestamp,
// not a toggle). The single NEXT un-done milestone shows a "Mark …" button (the
// driver advances in order). A later, not-yet-reachable milestone reads muted
// with an em-dash — shown so the whole load is visible at a glance, but not yet
// tappable (an out-of-order tap the server would reject).
function ProgressRow({
  step,
  busy,
  onMark,
}: {
  step: MilestoneStep;
  busy: boolean;
  onMark?: () => void;
}) {
  if (step.isDone) {
    return (
      <View style={styles.progressRow}>
        <Text style={styles.progressDone}>✓ {step.done}</Text>
        <Text style={styles.progressTime}>{formatClock(step.at)}</Text>
      </View>
    );
  }
  if (step.actionable && onMark) {
    return (
      <View style={styles.progressRow}>
        <Button title={busy ? "…" : step.action} onPress={onMark} disabled={busy} />
      </View>
    );
  }
  return (
    <View style={styles.progressRow}>
      <Text style={styles.progressPending}>{step.done}</Text>
      <Text style={styles.progressTime}>—</Text>
    </View>
  );
}

// Log a fuel fill against one of the driver's own trips (ADR-0034 D2 own-record
// scope). The driver picks a trip and the vehicle is DERIVED from it, so the
// server's trip-vehicle consistency check always passes. Liters + price are typed
// as decimals and converted to the integer mL / paisa the wire stores; the
// odometer reading is optional. The total preview mirrors the server's derived
// totalCostPaisa (same Math.round rule), so what the driver sees is what persists.
function FuelScreen() {
  const [trips, setTrips] = useState<DriverTrip[] | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [liters, setLiters] = useState("");
  const [price, setPrice] = useState("");
  const [odometer, setOdometer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Mount load — same pattern as TripScreen (setState in the promise continuation,
  // `active` flag drops a late response). Pre-select when there is exactly one trip.
  useEffect(() => {
    let active = true;
    listMyTrips()
      .then((items) => {
        if (active) {
          setTrips(items);
          if (items.length === 1) setSelectedTripId(items[0].id);
        }
      })
      .catch(() => {
        if (active) {
          setTrips([]);
          setError("Could not load your trips.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedTrip = trips?.find((trip) => trip.id === selectedTripId) ?? null;

  // Inline parse + bounds checks (mirroring TripRow). Bounds match the API's
  // LITERS_ML / PRICE_PAISA / ODOMETER limits after the human-units conversion.
  const litersNum = Number(liters);
  const litersValid =
    liters.trim() !== "" &&
    Number.isFinite(litersNum) &&
    litersNum >= 0.001 &&
    litersNum <= 1_000_000;
  const priceNum = Number(price);
  const priceValid =
    price.trim() !== "" && Number.isFinite(priceNum) && priceNum >= 0.01 && priceNum <= 100_000;
  const odometerEntered = odometer.trim() !== "";
  const odometerNum = Number(odometer);
  const odometerValid =
    !odometerEntered ||
    (Number.isInteger(odometerNum) && odometerNum >= 0 && odometerNum <= 100_000_000);

  const totalPaisa = previewTotalCostPaisa(
    litersValid ? litersNum : null,
    priceValid ? priceNum : null,
  );
  const canSubmit = selectedTrip !== null && litersValid && priceValid && odometerValid && !busy;

  async function submit() {
    if (!selectedTrip) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await createFuelLog(
        fuelLogPayload(
          {
            vehicleId: selectedTrip.vehicle.id,
            tripId: selectedTrip.id,
            liters: litersNum,
            pricePerLiter: priceNum,
            odometerKm: odometerEntered ? odometerNum : undefined,
          },
          new Date().toISOString(),
        ),
      );
      setLiters("");
      setPrice("");
      setOdometer("");
      setDone(true);
    } catch {
      setError("Could not log fuel.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.subScreen} contentContainerStyle={styles.fuelContent}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {done ? <Text style={styles.success}>Fuel logged.</Text> : null}

      {trips === null ? (
        <ActivityIndicator accessibilityLabel="Loading trips" style={styles.loading} />
      ) : trips.length === 0 ? (
        <Text style={styles.empty}>No trips assigned.</Text>
      ) : (
        <>
          <Text style={styles.label}>Trip</Text>
          {trips.map((trip) => (
            <Pressable
              key={trip.id}
              style={[styles.selectRow, selectedTripId === trip.id && styles.selectRowActive]}
              onPress={() => setSelectedTripId(trip.id)}
            >
              <Text style={styles.tripReg}>{trip.vehicle.registrationNumber}</Text>
              <Text style={styles.tripStatus}>{trip.status}</Text>
            </Pressable>
          ))}

          <Text style={styles.label}>Liters</Text>
          <TextInput
            style={styles.input}
            placeholder="0.000"
            keyboardType="decimal-pad"
            value={liters}
            onChangeText={(t) => {
              setLiters(t);
              setDone(false);
            }}
            editable={!busy}
          />

          <Text style={styles.label}>Price per liter (NPR)</Text>
          <TextInput
            style={styles.input}
            placeholder="0.00"
            keyboardType="decimal-pad"
            value={price}
            onChangeText={(t) => {
              setPrice(t);
              setDone(false);
            }}
            editable={!busy}
          />

          <Text style={styles.label}>Odometer (km, optional)</Text>
          <TextInput
            style={styles.input}
            placeholder="Odometer (km)"
            keyboardType="number-pad"
            value={odometer}
            onChangeText={(t) => {
              setOdometer(t);
              setDone(false);
            }}
            editable={!busy}
          />

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>
              {totalPaisa === null ? "—" : `NPR ${(totalPaisa / 100).toFixed(2)}`}
            </Text>
          </View>

          <Button
            title={busy ? "Logging…" : "Log fuel"}
            onPress={() => void submit()}
            disabled={!canSubmit}
          />
        </>
      )}
    </ScrollView>
  );
}

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read-and-clear on first render (a lazy initializer, not an effect — the
  // expo-SDK56 react-hooks rules ban setState-in-effect patterns): true when
  // apiFetch hit a 401 and signed us out, so the driver learns WHY they are
  // back here (ADR-0034 c3a) instead of facing an unexplained login screen.
  const [sessionExpired] = useState(() => consumeSessionExpired());

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.email({ email: email.trim(), password });
    if (result.error) {
      setError(result.error.message ?? "Sign-in failed.");
    }
    setBusy(false);
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>FleetCo Driver</Text>
      {sessionExpired ? (
        <Text style={styles.error}>Your session has expired. Please sign in again.</Text>
      ) : null}
      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button
        title={busy ? "Signing in…" : "Sign in"}
        onPress={() => void submit()}
        disabled={busy}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  screen: {
    flex: 1,
    width: "100%",
    maxWidth: 480,
    paddingTop: 48,
    gap: 8,
  },
  subScreen: {
    flex: 1,
    width: "100%",
  },
  fuelContent: {
    gap: 8,
    paddingBottom: 16,
  },
  panel: {
    width: "100%",
    maxWidth: 360,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    textAlign: "center",
  },
  email: {
    fontSize: 16,
    textAlign: "center",
  },
  role: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
  },
  tabs: {
    flexDirection: "row",
    gap: 8,
    marginVertical: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ccc",
    alignItems: "center",
  },
  tabActive: {
    backgroundColor: "#1f6feb",
    borderColor: "#1f6feb",
  },
  tabText: {
    fontSize: 15,
    color: "#1f6feb",
  },
  tabTextActive: {
    color: "#fff",
    fontWeight: "600",
  },
  loading: {
    marginTop: 24,
  },
  empty: {
    marginTop: 24,
    textAlign: "center",
    color: "#666",
  },
  list: {
    flex: 1,
    marginVertical: 12,
  },
  label: {
    fontSize: 13,
    color: "#666",
    marginTop: 4,
  },
  selectRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e2e2e2",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectRowActive: {
    borderColor: "#1f6feb",
    backgroundColor: "#eef4ff",
  },
  tripRow: {
    borderWidth: 1,
    borderColor: "#e2e2e2",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    gap: 8,
  },
  tripHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tripReg: {
    fontSize: 16,
    fontWeight: "600",
  },
  tripStatus: {
    fontSize: 12,
    color: "#666",
  },
  // Dispatch: the request-card route line + the order-detail rows (ADR-0047 W7).
  orderRoute: {
    fontSize: 14,
    color: "#333",
  },
  detailValue: {
    fontSize: 16,
    marginBottom: 2,
  },
  callLink: {
    fontSize: 16,
    color: "#1f6feb",
    paddingVertical: 4,
  },
  viewOrderLink: {
    fontSize: 14,
    color: "#1f6feb",
  },
  // Dispatch: the inline-map ETA preview label + the live-progress checklist
  // (ADR-0047 W8).
  etaLabel: {
    fontSize: 14,
    color: "#666",
    marginTop: 6,
  },
  progress: {
    marginTop: 12,
    gap: 6,
  },
  progressTitle: {
    fontSize: 13,
    color: "#666",
    marginBottom: 2,
  },
  progressRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: 32,
  },
  progressDone: {
    fontSize: 16,
    color: "#0a7d33",
  },
  progressPending: {
    fontSize: 16,
    color: "#999",
  },
  progressTime: {
    fontSize: 14,
    color: "#666",
    fontVariant: ["tabular-nums"],
  },
  backLink: {
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  backLinkText: {
    fontSize: 15,
    color: "#1f6feb",
  },
  tripActions: {
    // Column so an hour-metered (or BOTH) vehicle can stack its reading
    // input(s) above the action button without cramping (ADR-0036).
    flexDirection: "column",
    gap: 8,
  },
  reading: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
  },
  totalLabel: {
    fontSize: 15,
    color: "#666",
  },
  totalValue: {
    fontSize: 18,
    fontWeight: "600",
  },
  success: {
    color: "#0a7d33",
    textAlign: "center",
  },
  error: {
    color: "#b00020",
    textAlign: "center",
  },
});
