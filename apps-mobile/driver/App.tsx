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
import { consumeSessionExpired } from "./src/session-expired";
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

  // Initial load on mount: the fetch + setState live in the promise continuation
  // (never synchronously in the effect body), and the `active` flag drops a late
  // response that resolves after unmount.
  useEffect(() => {
    let active = true;
    listMyTrips()
      .then((items) => {
        if (active) setTrips(items);
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
  const transition = useCallback(
    async (trip: DriverTrip, readings: TripReadings, kind: "start" | "stop") => {
      setBusyId(trip.id);
      setError(null);
      try {
        const nowIso = new Date().toISOString();
        const payload =
          kind === "start"
            ? tripStartPayload(readings, nowIso)
            : tripStopPayload(readings, nowIso);
        await patchTrip(trip.id, payload);
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
  success: {
    color: "#0a7d33",
    textAlign: "center",
  },
  error: {
    color: "#b00020",
    textAlign: "center",
  },
});
