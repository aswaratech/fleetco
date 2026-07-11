// D5 background-GPS onboarding — the permission ladder + battery pointer
// (ADR-0035 c1). Background capture needs two grants Android only gives when
// ASKED WELL: "Allow all the time" location (API 30+ routes the request to a
// settings screen) and an exemption from battery optimization (on the
// aggressive OEMs common in Nepal — Xiaomi/Oppo/Vivo — the system otherwise
// kills the foreground service within minutes). The TripScreen card drives
// this flow; declining is a first-class outcome (the dismissed flag) that
// degrades capture to the foreground-only watch path with an honest note —
// never a nag loop. All native; tests never import this file.

import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import { Linking } from "react-native";

const DISMISSED_KEY = "fleetco.gps.onboarding.dismissed";

// Offer the upsell when background capture isn't possible yet and the driver
// hasn't said "not now". Any failure (no native runtime — Expo Go) → false:
// never show a card that can't deliver.
export async function shouldOfferBackgroundGps(): Promise<boolean> {
  try {
    if (await SecureStore.getItemAsync(DISMISSED_KEY)) {
      return false;
    }
    const background = await Location.getBackgroundPermissionsAsync();
    return !background.granted;
  } catch {
    return false;
  }
}

export async function dismissBackgroundGpsOffer(): Promise<void> {
  try {
    await SecureStore.setItemAsync(DISMISSED_KEY, "1");
  } catch {
    // worst case the offer shows again next launch
  }
}

export type BackgroundGpsRequestResult =
  | "background"
  | "foreground"
  | "denied"
  | "unavailable";

// The ladder itself: foreground first (background is meaningless without it),
// then background ("Allow all the time" — on API 30+ Android renders this as
// a settings screen, and the promise resolves when the driver returns).
export async function requestBackgroundGps(): Promise<BackgroundGpsRequestResult> {
  try {
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) {
      return "denied";
    }
    const background = await Location.requestBackgroundPermissionsAsync();
    return background.granted ? "background" : "foreground";
  } catch {
    return "unavailable";
  }
}

// The battery step can only POINT — Android exposes no supported API to read
// or set another app's optimization state without extra deps — so open the
// app's settings screen and let the copy explain what to tap.
export async function openBatterySettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    // nothing to do — the card copy still names the path through Settings
  }
}
