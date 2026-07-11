import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Button,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { createFuelLog, listMyTrips, patchTrip } from "./src/api";
import { authClient } from "./src/auth";
import { fuelLogPayload, previewTotalCostPaisa } from "./src/fuel";
import {
  dismissBackgroundGpsOffer,
  openBatterySettings,
  requestBackgroundGps,
  shouldOfferBackgroundGps,
} from "./src/gps-onboarding";
import { reconcileTripGps, startTripGps, stopTripGps } from "./src/gps-task";
import { consumeSessionExpired } from "./src/session-expired";
import { startSync } from "./src/sync-runtime";
import {
  isStartable,
  isStoppable,
  meterIncludesHours,
  meterIncludesOdometer,
  tripStartPayload,
  tripStopPayload,
  type DriverTrip,
  type TripReadings,
} from "./src/trips";

// D3 (ADR-0034): a signed-in driver works across two screens — start/stop their
// OWN trips (D2) and log a fuel fill + odometer reading against one of those trips
// (D3). A lightweight in-app toggle switches between them (no navigation library
// yet — the app stays a single conditional tree). When unauthenticated, show the
// login form (D1). Fuel/odometer entry lands here; GPS arrives in D4+.
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

// The signed-in shell: a shared header, a Trips / Log fuel toggle, the active
// screen, and sign-out. The toggle is a two-button segmented control; there is no
// navigation library yet, so the app stays a single conditional tree.
function HomeScreen({ email, role }: { email: string; role?: string | null }) {
  const [screen, setScreen] = useState<"trips" | "fuel">("trips");

  // Wire the SyncManager when the signed-in shell mounts (idempotent — D5,
  // ADR-0035 c2/c3): NetInfo + AppState + tick triggers, plus an immediate
  // sweep of anything buffered from before this session. No setState here.
  useEffect(() => {
    startSync();
  }, []);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>FleetCo Driver</Text>
      <Text style={styles.email}>{email}</Text>
      <Text style={styles.role}>{role ?? "—"}</Text>

      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, screen === "trips" && styles.tabActive]}
          onPress={() => setScreen("trips")}
        >
          <Text style={[styles.tabText, screen === "trips" && styles.tabTextActive]}>Trips</Text>
        </Pressable>
        <Pressable
          style={[styles.tab, screen === "fuel" && styles.tabActive]}
          onPress={() => setScreen("fuel")}
        >
          <Text style={[styles.tabText, screen === "fuel" && styles.tabTextActive]}>Log fuel</Text>
        </Pressable>
      </View>

      {screen === "trips" ? <TripScreen /> : <FuelScreen />}

      <Button title="Sign out" onPress={() => void authClient.signOut()} />
    </View>
  );
}

function TripScreen() {
  const [trips, setTrips] = useState<DriverTrip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  // The D5 background-GPS onboarding card (ADR-0035 c1): "offer" asks for
  // "Allow all the time", "battery" points at battery optimization after a
  // grant. null = nothing to show (granted, dismissed, or still checking).
  const [onboarding, setOnboarding] = useState<"offer" | "battery" | null>(null);

  // Same promise-continuation pattern as the trips load below (the expo-SDK56
  // react-hooks rules ban setState-in-effect-body).
  useEffect(() => {
    let active = true;
    shouldOfferBackgroundGps()
      .then((offer) => {
        if (active && offer) setOnboarding("offer");
      })
      .catch(() => {
        // no card is always a safe outcome
      });
    return () => {
      active = false;
    };
  }, []);

  // The ladder: foreground → background ("Allow all the time") → the battery
  // pointer. Any outcome short of a background grant sets the dismissed flag
  // (asking again would nag — the OS routes repeat asks to settings anyway)
  // and leaves an honest note about what capture will do instead.
  const runOnboarding = useCallback(async () => {
    const result = await requestBackgroundGps();
    if (result === "background") {
      setOnboarding("battery");
    } else {
      await dismissBackgroundGpsOffer();
      setOnboarding(null);
      setGpsNote(
        result === "denied"
          ? "GPS capture is off — location access was not allowed."
          : "GPS will record only while the app is open on screen.",
      );
    }
  }, []);

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
          } else if (gps === "started-foreground") {
            setGpsNote(
              "Trip started. GPS records only while the app is open — allow “all the time” location for background recording.",
            );
          }
          // "started-background" is the silent happy path — the foreground-
          // service notification is the honest signal capture is running
          // (ADR-0035 c1/c8, the D5 background window).
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

  return (
    <View style={styles.subScreen}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {gpsNote ? <Text style={styles.empty}>{gpsNote}</Text> : null}

      {onboarding === "offer" ? (
        <View style={styles.onboardingCard}>
          <Text style={styles.onboardingTitle}>Record trips in the background?</Text>
          <Text style={styles.onboardingBody}>
            Allow location {"“"}all the time{"”"} so the route keeps recording while
            the phone is in your pocket or the screen is off. The office then sees the truck
            move even when the app is closed.
          </Text>
          <View style={styles.onboardingActions}>
            <Button title="Allow background GPS" onPress={() => void runOnboarding()} />
            <Button
              title="Not now"
              onPress={() => {
                void dismissBackgroundGpsOffer();
                setOnboarding(null);
              }}
            />
          </View>
        </View>
      ) : null}

      {onboarding === "battery" ? (
        <View style={styles.onboardingCard}>
          <Text style={styles.onboardingTitle}>One more step: battery settings</Text>
          <Text style={styles.onboardingBody}>
            Many phones (Xiaomi, Oppo, Vivo and similar) stop background GPS to save
            battery. In the app{"’"}s settings, set Battery to {"“"}Unrestricted
            {"”"} (or turn off battery optimization) so recording is not killed
            mid-trip.
          </Text>
          <View style={styles.onboardingActions}>
            <Button title="Open settings" onPress={() => void openBatterySettings()} />
            <Button title="Done" onPress={() => setOnboarding(null)} />
          </View>
        </View>
      ) : null}

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
}: {
  trip: DriverTrip;
  busy: boolean;
  onStart: (readings: TripReadings) => void;
  onStop: (readings: TripReadings) => void;
}) {
  const [odometer, setOdometer] = useState("");
  const [hours, setHours] = useState("");
  const startable = isStartable(trip);
  const stoppable = isStoppable(trip);

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
  onboardingCard: {
    borderWidth: 1,
    borderColor: "#1f6feb",
    backgroundColor: "#eef4ff",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    gap: 8,
  },
  onboardingTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  onboardingBody: {
    fontSize: 13,
    color: "#444",
  },
  onboardingActions: {
    gap: 4,
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
