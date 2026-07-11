import { registerRootComponent } from 'expo';

// The GPS task must be DEFINED in every JS init — including the headless
// relaunch after a force-stop, where the surviving foreground service starts
// the runtime without mounting React (ADR-0035 c1, D5). Importing the module
// here (explicitly, not just via App's import graph) is what guarantees
// TaskManager.defineTask has run before the first location event arrives.
import './src/gps-task';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
