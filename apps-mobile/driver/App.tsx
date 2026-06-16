import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Button,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { listMyTrips, patchTrip } from "./src/api";
import { authClient } from "./src/auth";
import {
  isStartable,
  isStoppable,
  tripStartPayload,
  tripStopPayload,
  type DriverTrip,
} from "./src/trips";

// D2 (ADR-0034): a driver authenticates, then starts/stops their OWN trips. When
// unauthenticated, show the login form (D1); once signed in, show the trip
// screen. The trip list is auto-scoped to the signed-in driver server-side, and
// start/stop reuse PATCH /trips/:id with the own-record predicate. Fuel/odometer
// entry and GPS arrive in D3+.
export default function App() {
  const { data: session, isPending } = authClient.useSession();

  let body;
  if (isPending) {
    body = <ActivityIndicator accessibilityLabel="Loading" />;
  } else if (session) {
    body = <TripScreen email={session.user.email} role={session.user.role} />;
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

function TripScreen({ email, role }: { email: string; role?: string | null }) {
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
  // effect), so these are ordinary event-driven state updates.
  const transition = useCallback(
    async (trip: DriverTrip, odometerKm: number, kind: "start" | "stop") => {
      setBusyId(trip.id);
      setError(null);
      try {
        const nowIso = new Date().toISOString();
        const payload =
          kind === "start"
            ? tripStartPayload(odometerKm, nowIso)
            : tripStopPayload(odometerKm, nowIso);
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
    <View style={styles.screen}>
      <Text style={styles.title}>FleetCo Driver</Text>
      <Text style={styles.email}>{email}</Text>
      <Text style={styles.role}>{role ?? "—"}</Text>
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
              onStart={(km) => void transition(item, km, "start")}
              onStop={(km) => void transition(item, km, "stop")}
            />
          )}
        />
      )}

      <Button title="Sign out" onPress={() => void authClient.signOut()} />
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
  onStart: (odometerKm: number) => void;
  onStop: (odometerKm: number) => void;
}) {
  const [odometer, setOdometer] = useState("");
  const startable = isStartable(trip);
  const stoppable = isStoppable(trip);
  const km = Number.parseInt(odometer, 10);
  const kmValid = Number.isFinite(km) && km >= 0;

  return (
    <View style={styles.tripRow}>
      <View style={styles.tripHeader}>
        <Text style={styles.tripReg}>{trip.vehicle.registrationNumber}</Text>
        <Text style={styles.tripStatus}>{trip.status}</Text>
      </View>
      {startable || stoppable ? (
        <View style={styles.tripActions}>
          <TextInput
            style={styles.odometer}
            placeholder="Odometer (km)"
            keyboardType="number-pad"
            value={odometer}
            onChangeText={setOdometer}
            editable={!busy}
          />
          <Button
            title={busy ? "…" : startable ? "Start trip" : "End trip"}
            disabled={busy || !kmValid}
            onPress={() => (startable ? onStart(km) : onStop(km))}
          />
        </View>
      ) : null}
    </View>
  );
}

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  odometer: {
    flex: 1,
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
  error: {
    color: "#b00020",
    textAlign: "center",
  },
});
