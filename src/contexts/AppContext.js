import { createContext, useContext } from 'react';

// Create the context
export const AppContext = createContext({
  levels: [],
  setLevels: () => {},
  selectedLevel: null,
  setSelectedLevel: () => {},
  selectedDevice: null,
  setSelectedDevice: () => {},
  placementMode: null,
  setPlacementMode: () => {},
});

// Custom hook for using the context
export const useAppContext = () => useContext(AppContext);