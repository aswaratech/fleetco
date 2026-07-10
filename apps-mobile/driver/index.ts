import { registerRootComponent } from 'expo';

// Register the D4 trip-GPS location task BEFORE the app registers —
// expo-task-manager requires task definitions to exist at module load,
// outside any component (its defineTask contract).
import './src/gps-task';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
