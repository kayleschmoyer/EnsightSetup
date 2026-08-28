/**
 * ConfigService - Handles reading and writing device configuration to local XML files
 *
 * Config file locations:
 * - Cameras:
 *   - C:\Ensight\CameraHub\camerahub-config.xml
 *   - C:\Ensight\EPIC\Config\DevicesConfig.xml
 *   - C:\Ensight\FLI\Config\{CameraName}.xml
 * - Signs:
 *   - C:\Ensight\EPIC\Config\DevicesConfig.xml
 * - Space Monitors (Sensor Groups: NWAVE, Parksol, Proco, Ensight Vision):
 *   - C:\Ensight\EPIC\Config\DevicesConfig.xml
 *   - NWAVE sensors use type SENSORCONTROLLER with API key as controllerKey
 */

import { js2xml, xml2js } from 'xml-js';
import { resolveTrafficDirectionForExport } from '../lib/trafficFlowUtils';

// ========================= CONSTANTS =========================

const XML_OPTIONS = {
  compact: true,
  ignoreComment: true,
  spaces: 2
};

const XML_PARSE_OPTIONS = {
  compact: true,
  ignoreComment: true,
  alwaysArray: false,
  nativeType: true,
  trim: true
};

// Default camera settings for FLI cameras
const DEFAULT_CAMERA_SETTINGS = {
  FPS: 5,
  RecordRawClips: false,
  Enabled: true,
  MotionThreshold: 0.1,
  PreRollBufferSeconds: 0.5
};

// Default FLI plugin config settings
const DEFAULT_FLI_CONFIG = {
  EnhancedVisuals: true,
  ResizeWidth: 0,
  FLIConfig: {
    DetectionInterval: 2,
    ConfidenceThreshold: 40,
    Frame: {
      Width: 640,
      Height: 480
    },
    ReportFLI: true,
    ROI: {
      Location: { X: 0, Y: 0 },
      Size: { Width: 640, Height: 480 },
      X: 0,
      Y: 0,
      Width: 640,
      Height: 480
    },
    MotionDetectionSensitivity: 40,
    ROEs: {},
    CountLineUp: { X1: 93, Y1: 202, X2: 555, Y2: 169 },
    CountLineDown: { X1: 96, Y1: 215, X2: 562, Y2: 186 },
    LargeBoundingBoxMaxWidth: 0,
    LargeBoundingBoxMaxHeight: 0,
    MaximumAllowedCountedDistance: 140,
    MinimumSameObjectOverlap: 0.17,
    RecordCountFrames: false,
    RecordLowConfidenceFrames: false,
    DetectionBoxScale: 1,
    FramesReceivedTimeoutMs: 500,
    AllowTurnarounds: true,
    PersistDetections: true,
    MaxAllowedBoxJump: 200
  }
};

// ========================= HELPER FUNCTIONS =========================

/**
 * Extract IP address from RTSP URL
 */
const extractIPFromRTSP = (rtspUrl) => {
  if (!rtspUrl) return '';
  const match = rtspUrl.match(/@([\d.]+):/);
  return match ? match[1] : '';
};

/**
 * Extract port from RTSP URL
 */
const extractPortFromRTSP = (rtspUrl) => {
  if (!rtspUrl) return '554';
  const match = rtspUrl.match(/:(\d+)\//);
  return match ? match[1] : '554';
};

/**
 * Build RTSP URL from components
 */
const buildRTSPUrl = (ipAddress, port = '554', username = 'admin', password = 'Schneider1!') => {
  return `rtsp://${username}:${password}@${ipAddress}:${port}/0/onvif/profile2/media.smp`;
};

/**
 * Map camera type to config type
 */
const getCameraConfigType = (type) => {
  if (type === 'cam-fli') return 'FLI';
  if (type === 'cam-lpr') return 'LPR';
  if (type === 'cam-people') return 'PEOPLE';
  return 'FLI';
};

/**
 * Map device type to DevicesConfig type
 * @param {string} type - Device type
 * @param {Object} device - Full device object (optional) for checking sensorGroup
 */
const getDeviceConfigType = (type, device = null) => {
  if (type?.startsWith('cam-')) return 'CAMERA';
  if (type?.startsWith('sign-')) return 'SIGNCONTROLLER';
  if (type?.startsWith('sensor-')) {
    // For NWAVE sensors, type is SENSORCONTROLLER
    if (type === 'sensor-nwave' || device?.sensorGroup === 'sensor-nwave') {
      return 'SENSORCONTROLLER';
    }
    return 'SENSOR';
  }
  return 'UNKNOWN';
};

/**
 * Get text content from XML element
 */
const getTextContent = (element) => {
  if (element === undefined || element === null) return '';
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  if (element._text !== undefined) return String(element._text);
  if (element._cdata !== undefined) return String(element._cdata);
  return '';
};

// ========================= CAMERAHUB CONFIG =========================

/**
 * Generate CameraHub config XML content (camerahub-config.xml)
 * For dual-lens cameras, generates separate entries for each stream
 */
export const generateCameraHubConfig = (cameras) => {
  const cameraEntries = [];

  cameras.forEach(cam => {
    const isDualLens = cam.hardwareType === 'dual-lens';

    if (isDualLens) {
      // Generate entries for both streams
      [1, 2].forEach(streamNum => {
        const rawStream = streamNum === 1 ? cam.stream1 : cam.stream2;
        const stream = (typeof rawStream === 'object' && rawStream !== null) ? rawStream : null;
        const streamStr = typeof rawStream === 'string' ? rawStream : '';
        if (!stream?.ipAddress && !stream?.externalUrl && !streamStr) return;

        const ipAddress = stream?.ipAddress || '';
        const port = stream?.port || '554';
        const rtspUrl = stream?.externalUrl
          || streamStr
          || (ipAddress ? buildRTSPUrl(ipAddress, port) : '');
        const streamType = stream?.streamType || cam.type || 'cam-fli';
        const streamName = `${cam.name}-S${streamNum}`;

        const entry = {
          Name: { _text: streamName },
          RTSPUrl: { _text: rtspUrl },
          FPS: { _text: DEFAULT_CAMERA_SETTINGS.FPS },
          Type: { _text: getCameraConfigType(streamType) },
          RecordRawClips: { _text: DEFAULT_CAMERA_SETTINGS.RecordRawClips },
          Enabled: { _text: DEFAULT_CAMERA_SETTINGS.Enabled },
          MotionThreshold: { _text: DEFAULT_CAMERA_SETTINGS.MotionThreshold },
          PreRollBufferSeconds: { _text: DEFAULT_CAMERA_SETTINGS.PreRollBufferSeconds }
        };

        // Optional DigitalZoomArea
        if (stream?.digitalZoomArea) {
          entry.DigitalZoomArea = {
            X: { _text: stream.digitalZoomArea.x ?? 0 },
            Y: { _text: stream.digitalZoomArea.y ?? 0 },
            Width: { _text: stream.digitalZoomArea.width ?? 640 },
            Height: { _text: stream.digitalZoomArea.height ?? 480 }
          };
        }

        cameraEntries.push(entry);
      });
    } else {
      // Single stream camera (bullet)
      const stream1 = (typeof cam.stream1 === 'object' && cam.stream1 !== null) ? cam.stream1 : null;
      const ipAddress = stream1?.ipAddress || cam.ipAddress || '';
      const port = stream1?.port || cam.port || '554';
      // Resolve RTSP URL: structured stream1 object → flat externalUrl → flat rtspUrl → flat stream1 string → build from IP
      const rtspUrl = stream1?.externalUrl
        || cam.externalUrl
        || cam.rtspUrl
        || (typeof cam.stream1 === 'string' && cam.stream1 ? cam.stream1 : '')
        || (ipAddress ? buildRTSPUrl(ipAddress, port) : '');

      const entry = {
        Name: { _text: cam.name },
        RTSPUrl: { _text: rtspUrl },
        FPS: { _text: DEFAULT_CAMERA_SETTINGS.FPS },
        Type: { _text: getCameraConfigType(cam.type) },
        RecordRawClips: { _text: DEFAULT_CAMERA_SETTINGS.RecordRawClips },
        Enabled: { _text: DEFAULT_CAMERA_SETTINGS.Enabled },
        MotionThreshold: { _text: DEFAULT_CAMERA_SETTINGS.MotionThreshold },
        PreRollBufferSeconds: { _text: DEFAULT_CAMERA_SETTINGS.PreRollBufferSeconds }
      };

      // Optional DigitalZoomArea
      const zoom = cam.stream1?.digitalZoomArea || cam.digitalZoomArea;
      if (zoom) {
        entry.DigitalZoomArea = {
          X: { _text: zoom.x ?? 0 },
          Y: { _text: zoom.y ?? 0 },
          Width: { _text: zoom.width ?? 640 },
          Height: { _text: zoom.height ?? 480 }
        };
      }

      cameraEntries.push(entry);
    }
  });

  const config = {
    _declaration: { _attributes: { version: '1.0', encoding: 'utf-8' } },
    CameraHub: {
      _attributes: {
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema'
      },
      Cameras: {
        Camera: cameraEntries.length > 0 ? cameraEntries : []
      },
      VideoClipRoot: { _text: 'C:\\videos' },
      MaxFileAgeDays: { _text: 10 }
    }
  };

  return js2xml(config, XML_OPTIONS);
};

/**
 * Parse CameraHub config XML
 * Supports both <CameraHubConfig> and <CameraHub> root elements
 */
export const parseCameraHubConfig = (xmlContent) => {
  try {
    const result = xml2js(xmlContent, XML_PARSE_OPTIONS);
    const cameras = [];

    // Parse Cameras section - support both CameraHubConfig and CameraHub root elements
    const root = result?.CameraHubConfig || result?.CameraHub;
    const camerasSection = root?.Cameras?.Camera;
    if (camerasSection) {
      const cameraArray = Array.isArray(camerasSection) ? camerasSection : [camerasSection];
      cameraArray.forEach(cam => {
        const name = getTextContent(cam.Name);
        const rtspUrl = getTextContent(cam.RTSPUrl);
        const type = getTextContent(cam.Type);
        const macAddress = getTextContent(cam.MACAddress);

        const ipAddress = extractIPFromRTSP(rtspUrl);
        const port = extractPortFromRTSP(rtspUrl);

        cameras.push({
          id: Date.now() + Math.random(),
          name,
          type: type === 'FLI' ? 'cam-fli' : type === 'LPR' ? 'cam-lpr' : 'cam-people',
          hardwareType: 'bullet',
          ipAddress,
          port,
          macAddress,
          externalUrl: rtspUrl,
          stream1: {
            ipAddress,
            port,
            externalUrl: rtspUrl,
            direction: 'in',
            rotation: 0,
            flowDestination: 'site-entry'
          },
          // No x,y coordinates - device is pending placement on canvas
          pendingPlacement: true
        });
      });
    }

    return cameras;
  } catch (error) {
    console.error('Error parsing CameraHub config:', error);
    return [];
  }
};

// ========================= EPIC CONFIGURATION (Configuration.xml) =========================

/**
 * Generate Epic Configuration.xml content
 * @param {Array} sites - All sites with their levels and devices
 * @param {Object} options - Optional overrides: { projectName, country, apiKey, apiHost }
 */
export const generateEpicConfiguration = (sites, options = {}) => {
  const projectName = options.projectName || 'EnsightProject';
  const country = options.country || 'US';
  const apiHost = options.apiHost || 'https://data.ensightful.io/v1';
  const apiKey = options.apiKey || 'yRX9QAUNl3aTIMjtK4g5x8rTvkOeUl1KaloJnPCz';

  // XML element names below (Garages/Garage) are the fixed Epic/Ensight backend
  // config contract — not renamed, even though the JS-side vocabulary is "site".
  const garageElements = sites.map(g => {
    const levels = Array.isArray(g.levels) ? g.levels : [];

    const parkingLevelElements = levels.map(lvl => {
      const cfg = lvl.config || {};
      const devices = Array.isArray(lvl.devices) ? lvl.devices : [];
      const cameras = devices.filter(d => d.type?.startsWith('cam-'));

      // Build Events from cameras on this level
      const eventElements = [];
      cameras.forEach(cam => {
        const isDualLens = cam.hardwareType === 'dual-lens';

        if (isDualLens) {
          [1, 2].forEach(streamNum => {
            const stream = streamNum === 1 ? cam.stream1 : cam.stream2;
            if (!stream || (!stream.ipAddress && !stream.externalUrl)) return;
            const streamType = stream.streamType || cam.type || 'cam-fli';
            const isFLI = streamType === 'cam-fli';
            const dir = resolveTrafficDirectionForExport(
              stream.direction,
              cam.trafficFlow?.direction,
              cam.direction
            );

            eventElements.push({
              DeviceName: { _text: `${cam.name}-S${streamNum}` },
              IngressEvent: { _text: dir === 'in' ? 'DOWN' : 'UP' },
              EgressEvent: { _text: dir === 'in' ? 'UP' : 'DOWN' },
              IsEntryExitCamera: { _text: isFLI }
            });
          });
        } else {
          const isFLI = cam.type === 'cam-fli';
          const dir = resolveTrafficDirectionForExport(
            cam.stream1?.direction,
            cam.trafficFlow?.direction,
            cam.direction
          );

          eventElements.push({
            DeviceName: { _text: cam.name },
            IngressEvent: { _text: dir === 'in' ? 'DOWN' : 'UP' },
            EgressEvent: { _text: dir === 'in' ? 'UP' : 'DOWN' },
            IsEntryExitCamera: { _text: isFLI }
          });
        }
      });

      // Determine counting strategy based on device types present
      const hasFLI = cameras.some(c => {
        if (c.hardwareType === 'dual-lens') {
          return [c.stream1, c.stream2].some(s => (s?.streamType || c.type) === 'cam-fli');
        }
        return c.type === 'cam-fli';
      });
      const countingStrategy = hasFLI ? 'FLI' : 'LPR';

      const levelElement = {
        Name: { _text: lvl.name || '' },
        MaximumOccupancy: { _text: cfg.maximumOccupancy ?? lvl.totalSpots ?? 100 },
        AutoResetCountsEnabled: { _text: cfg.autoResetCountsEnabled ?? true },
        AutoResetCountValue: { _text: cfg.autoResetCountValue ?? 0 },
        AutoResetCountTime: { _text: cfg.autoResetCountTime || '04:00' },
        ForceFullVacancyThreshold: { _text: cfg.forceFullVacancyThreshold ?? 200 },
        VehicleTransitThreshold: { _text: cfg.vehicleTransitThreshold ?? 50 },
        VehicleTransitThresholdTTLSeconds: { _text: cfg.vehicleTransitThresholdTTLSeconds ?? 10 },
        ShowFullMessage: { _text: cfg.showFullMessage ?? true },
        ShowFullMessageRed: { _text: cfg.showFullMessageRed ?? true },
        PortalDisplayOrdinal: { _text: cfg.portalDisplayOrdinal ?? 1 },
        SignDisplayOrdinal: { _text: cfg.signDisplayOrdinal ?? 1 },
        TypeName: { _text: cfg.levelType || 'General' },
        CountingStrategyType: { _text: countingStrategy }
      };

      if (eventElements.length > 0) {
        levelElement.Events = {
          Event: eventElements
        };
      }

      return levelElement;
    });

    const garageElement = {
      Name: { _text: g.name || '' },
      Location: {
        Country: { _text: g.country || country }
      }
    };

    if (parkingLevelElements.length > 0) {
      garageElement.ParkingLevels = {
        ParkingLevel: parkingLevelElements
      };
    } else {
      garageElement.ParkingLevels = {};
    }

    return garageElement;
  });

  const config = {
    _declaration: { _attributes: { version: '1.0' } },
    Ensight: {
      _attributes: {
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema'
      },
      ConnectionStrings: {
        EpicDb: { _text: 'Server=.\\SQLEXPRESS;Database=EpicData;MultipleActiveResultSets=True;Integrated Security=SSPI;TrustServerCertificate=True' },
        FLIDb: { _text: 'Server=.\\SQLEXPRESS;Database=FliSpyData;MultipleActiveResultSets=True;Integrated Security=SSPI;TrustServerCertificate=True' }
      },
      EnsightAPIConfig: {
        Host: { _text: apiHost },
        APIKey: { _text: apiKey }
      },
      ReplicationType: { _text: 'Primary' },
      VehicleCountStrategy: { _text: 'POLL' },
      PollIntervalSeconds: { _text: 15 },
      ReportDataToCloud: { _text: true },
      Project: {
        Name: { _text: projectName }
      },
      Garages: {
        Garage: garageElements.length > 0 ? garageElements : []
      },
      Displays: {
        DisplayGroup: {
          Name: { _text: 'MainGroup' },
          SendOnlyOnUpdates: { _text: false },
          ForceSendAfterSeconds: { _text: 120 }
        }
      }
    }
  };

  return js2xml(config, XML_OPTIONS);
};

// ========================= DEVICES CONFIG =========================

/**
 * Generate DevicesConfig.xml content
 * For dual-lens cameras, generates separate entries for each stream
 */
export const generateDevicesConfig = (devices) => {
  const deviceElements = [];

  devices.forEach(device => {
    const isCamera = device.type?.startsWith('cam-');
    const isDualLens = device.hardwareType === 'dual-lens';

    if (isCamera && isDualLens) {
      // Generate entries for both streams
      [1, 2].forEach(streamNum => {
        const stream = streamNum === 1 ? device.stream1 : device.stream2;
        if (!stream?.ipAddress) return; // Skip if stream not configured

        const ipAddress = stream.ipAddress || '';
        const port = stream.port || '554';
        const streamName = `${device.name}-S${streamNum}`;

        deviceElements.push({
          Name: { _text: streamName },
          IPAddress: { _text: ipAddress },
          Port: { _text: port },
          Type: { _text: 'CAMERA' },
          ...(device.macAddress && { MACAddress: { _text: device.macAddress } })
        });
      });
    } else {
      // Single stream camera or non-camera device
      const ipAddress = device.stream1?.ipAddress || device.ipAddress || '';
      const port = device.stream1?.port || device.port || (device.type?.startsWith('sign-') ? '10001' : '554');
      const configType = getDeviceConfigType(device.type, device);

      const deviceElement = {
        Name: { _text: device.name },
        IPAddress: { _text: ipAddress },
        Port: { _text: port },
        Type: { _text: configType }
      };

      // Add MAC Address for cameras and signs
      if ((device.type?.startsWith('cam-') || device.type?.startsWith('sign-')) && device.macAddress) {
        deviceElement.MACAddress = { _text: device.macAddress };
      }

      // Add sensor-specific fields
      if (device.type?.startsWith('sensor-')) {
        if (device.sensorId) {
          deviceElement.SensorID = { _text: device.sensorId };
        }
        if (device.serialAddress) {
          deviceElement.SerialAddress = { _text: device.serialAddress };
        }
        if (device.parkingType) {
          deviceElement.ParkingType = { _text: device.parkingType.toUpperCase() };
        }
        if (device.tempParkingTimeMinutes) {
          deviceElement.TempParkingTimeMinutes = { _text: device.tempParkingTimeMinutes };
        }
        // For NWAVE, controllerKey is the API Key
        if (device.controllerKey && (device.type === 'sensor-nwave' || device.sensorGroup === 'sensor-nwave')) {
          deviceElement.ControllerKey = { _text: device.controllerKey };
        }
      }

      deviceElements.push(deviceElement);
    }
  });

  const config = {
    _declaration: { _attributes: { version: '1.0' } },
    Devices: {
      Device: deviceElements.length > 0 ? deviceElements : []
    }
  };

  return js2xml(config, XML_OPTIONS);
};

/**
 * Parse DevicesConfig.xml content
 */
export const parseDevicesConfig = (xmlContent) => {
  try {
    const result = xml2js(xmlContent, XML_PARSE_OPTIONS);
    const devices = [];

    const devicesSection = result?.Devices?.Device;
    if (devicesSection) {
      const deviceArray = Array.isArray(devicesSection) ? devicesSection : [devicesSection];
      deviceArray.forEach(dev => {
        const name = getTextContent(dev.Name);
        const ipAddress = getTextContent(dev.IPAddress);
        const port = getTextContent(dev.Port);
        const type = getTextContent(dev.Type);

        let deviceType = 'cam-fli';
        let sensorGroup = '';
        if (type === 'CAMERA') deviceType = 'cam-fli';
        else if (type === 'SIGNCONTROLLER') deviceType = 'sign-led';
        else if (type === 'SENSORCONTROLLER') {
          deviceType = 'sensor-nwave';
          sensorGroup = 'sensor-nwave';
        }
        else if (type === 'SENSOR') {
          deviceType = 'sensor-space';
          sensorGroup = 'sensor-space';
        }

        // Parse additional sensor fields
        const sensorId = getTextContent(dev.SensorID);
        const serialAddress = getTextContent(dev.SerialAddress);
        const parkingType = getTextContent(dev.ParkingType)?.toLowerCase() || 'normal';
        const tempParkingTimeMinutes = getTextContent(dev.TempParkingTimeMinutes);
        const controllerKey = getTextContent(dev.ControllerKey);
        const macAddress = getTextContent(dev.MACAddress);

        devices.push({
          id: Date.now() + Math.random(),
          name,
          type: deviceType,
          sensorGroup,
          ipAddress,
          port,
          macAddress,
          sensorId,
          serialAddress,
          parkingType,
          tempParkingTimeMinutes,
          controllerKey,
          stream1: {
            ipAddress,
            port,
            direction: 'in',
            rotation: 0,
            flowDestination: 'site-entry'
          },
          // No x,y coordinates - device is pending placement on canvas
          pendingPlacement: true
        });
      });
    }

    return devices;
  } catch (error) {
    console.error('Error parsing DevicesConfig:', error);
    return [];
  }
};

// ========================= FLI CAMERA CONFIG =========================

/**
 * Generate individual FLI camera config XML
 * @param {Object} camera - Camera object
 * @param {string} [overrideName] - Optional name override for dual-lens stream naming
 */
export const generateFLICameraConfig = (camera, overrideName = null) => {
  const config = {
    _declaration: { _attributes: { version: '1.0', encoding: 'utf-8' } },
    PluginConfig: {
      _attributes: {
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema'
      },
      CameraName: { _text: overrideName || camera.name },
      EnhancedVisuals: { _text: DEFAULT_FLI_CONFIG.EnhancedVisuals },
      ResizeWidth: { _text: DEFAULT_FLI_CONFIG.ResizeWidth },
      FLIConfig: {
        Frame: {
          Width: { _text: DEFAULT_FLI_CONFIG.FLIConfig.Frame.Width },
          Height: { _text: DEFAULT_FLI_CONFIG.FLIConfig.Frame.Height }
        },
        ReportFLI: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ReportFLI },
        MotionDetectionSensitivity: { _text: DEFAULT_FLI_CONFIG.FLIConfig.MotionDetectionSensitivity },
        ROI: {
          Location: {
            X: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ROI.Location.X },
            Y: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ROI.Location.Y }
          },
          Size: {
            Width: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ROI.Size.Width },
            Height: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ROI.Size.Height }
          },
          X: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ROI.X },
          Y: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ROI.Y },
          Width: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ROI.Width },
          Height: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ROI.Height }
        },
        ROEs: {},
        ConfidenceThreshold: { _text: DEFAULT_FLI_CONFIG.FLIConfig.ConfidenceThreshold },
        CountLineUp: {
          X1: { _text: DEFAULT_FLI_CONFIG.FLIConfig.CountLineUp.X1 },
          Y1: { _text: DEFAULT_FLI_CONFIG.FLIConfig.CountLineUp.Y1 },
          X2: { _text: DEFAULT_FLI_CONFIG.FLIConfig.CountLineUp.X2 },
          Y2: { _text: DEFAULT_FLI_CONFIG.FLIConfig.CountLineUp.Y2 }
        },
        CountLineDown: {
          X1: { _text: DEFAULT_FLI_CONFIG.FLIConfig.CountLineDown.X1 },
          Y1: { _text: DEFAULT_FLI_CONFIG.FLIConfig.CountLineDown.Y1 },
          X2: { _text: DEFAULT_FLI_CONFIG.FLIConfig.CountLineDown.X2 },
          Y2: { _text: DEFAULT_FLI_CONFIG.FLIConfig.CountLineDown.Y2 }
        },
        LargeBoundingBoxMaxWidth: { _text: DEFAULT_FLI_CONFIG.FLIConfig.LargeBoundingBoxMaxWidth },
        LargeBoundingBoxMaxHeight: { _text: DEFAULT_FLI_CONFIG.FLIConfig.LargeBoundingBoxMaxHeight },
        MaximumAllowedCountedDistance: { _text: DEFAULT_FLI_CONFIG.FLIConfig.MaximumAllowedCountedDistance },
        MinimumSameObjectOverlap: { _text: DEFAULT_FLI_CONFIG.FLIConfig.MinimumSameObjectOverlap },
        RecordCountFrames: { _text: DEFAULT_FLI_CONFIG.FLIConfig.RecordCountFrames },
        RecordLowConfidenceFrames: { _text: DEFAULT_FLI_CONFIG.FLIConfig.RecordLowConfidenceFrames },
        DetectionBoxScale: { _text: DEFAULT_FLI_CONFIG.FLIConfig.DetectionBoxScale },
        FramesReceivedTimeoutMs: { _text: DEFAULT_FLI_CONFIG.FLIConfig.FramesReceivedTimeoutMs },
        AllowTurnarounds: { _text: DEFAULT_FLI_CONFIG.FLIConfig.AllowTurnarounds },
        PersistDetections: { _text: DEFAULT_FLI_CONFIG.FLIConfig.PersistDetections },
        MaxAllowedBoxJump: { _text: DEFAULT_FLI_CONFIG.FLIConfig.MaxAllowedBoxJump }
      }
    }
  };

  return js2xml(config, XML_OPTIONS);
};

// ========================= FILE OPERATIONS =========================

/**
 * Download content as a file
 */
export const downloadFile = (content, filename, mimeType = 'application/xml') => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Read file content as text
 */
export const readFileAsText = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (e) => reject(e);
    reader.readAsText(file);
  });
};

// ========================= EXPORT ALL CONFIGS =========================

/**
 * Export all device configs as a ZIP-like bundle (downloads each file)
 * Handles dual-lens cameras by generating separate configs for each FLI stream
 * @param {Array} allDevices - All devices to export
 * @param {Object} options - { sites, projectName } for Configuration.xml
 */
export const exportAllConfigs = (allDevices, options = {}) => {
  const cameras = allDevices.filter(d => d.type?.startsWith('cam-'));
  const signs = allDevices.filter(d => d.type?.startsWith('sign-'));
  const sensors = allDevices.filter(d => d.type?.startsWith('sensor-'));

  // Generate and download CameraHub config
  if (cameras.length > 0) {
    const cameraHubConfig = generateCameraHubConfig(cameras);
    downloadFile(cameraHubConfig, 'camerahub-config.xml');
  }

  // Generate and download DevicesConfig (all devices)
  const devicesConfig = generateDevicesConfig(allDevices);
  downloadFile(devicesConfig, 'DevicesConfig.xml');

  // Generate and download Configuration.xml (Epic config)
  if (options.sites && options.sites.length > 0) {
    const epicConfig = generateEpicConfiguration(options.sites, {
      projectName: options.projectName
    });
    downloadFile(epicConfig, 'Configuration.xml');
  }

  // Generate and download individual FLI camera configs
  let fliConfigCount = 0;
  cameras.forEach(camera => {
    const isDualLens = camera.hardwareType === 'dual-lens';

    if (isDualLens) {
      // Check each stream for FLI type
      [1, 2].forEach(streamNum => {
        const stream = streamNum === 1 ? camera.stream1 : camera.stream2;
        const streamType = stream?.streamType || camera.type;
        if (streamType === 'cam-fli' && stream?.ipAddress) {
          const streamName = `${camera.name}-S${streamNum}`;
          const fliConfig = generateFLICameraConfig(camera, streamName);
          downloadFile(fliConfig, `${streamName}.xml`);
          fliConfigCount++;
        }
      });
    } else if (camera.type === 'cam-fli') {
      const fliConfig = generateFLICameraConfig(camera);
      downloadFile(fliConfig, `${camera.name}.xml`);
      fliConfigCount++;
    }
  });

  return {
    cameraHubConfig: cameras.length > 0,
    devicesConfig: true,
    epicConfig: !!(options.sites && options.sites.length > 0),
    fliConfigs: fliConfigCount
  };
};

/**
 * Export single device config
 * Handles dual-lens cameras by generating separate configs for each stream
 */
export const exportDeviceConfig = (device) => {
  const isDualLens = device.hardwareType === 'dual-lens';

  if (device.type?.startsWith('cam-')) {
    // Export camera config
    const cameraHubConfig = generateCameraHubConfig([device]);
    downloadFile(cameraHubConfig, `${device.name}-camerahub.xml`);

    // Export FLI configs
    if (isDualLens) {
      [1, 2].forEach(streamNum => {
        const stream = streamNum === 1 ? device.stream1 : device.stream2;
        const streamType = stream?.streamType || device.type;
        if (streamType === 'cam-fli' && stream?.ipAddress) {
          const streamName = `${device.name}-S${streamNum}`;
          const fliConfig = generateFLICameraConfig(device, streamName);
          downloadFile(fliConfig, `${streamName}.xml`);
        }
      });
    } else if (device.type === 'cam-fli') {
      const fliConfig = generateFLICameraConfig(device);
      downloadFile(fliConfig, `${device.name}.xml`);
    }
  }

  // Always export device entry
  const devicesConfig = generateDevicesConfig([device]);
  downloadFile(devicesConfig, `${device.name}-device.xml`);
};

// ========================= CONFIG FILE PATHS =========================

/**
 * Get the expected config file paths for a device
 * Handles dual-lens cameras by showing paths for each FLI stream
 */
export const getConfigFilePaths = (device) => {
  const paths = [];
  const isDualLens = device.hardwareType === 'dual-lens';

  if (device.type?.startsWith('cam-')) {
    paths.push('C:\\Ensight\\CameraHub\\camerahub-config.xml');
    paths.push('C:\\Ensight\\EPIC\\Config\\DevicesConfig.xml');

    if (isDualLens) {
      // Check each stream for FLI type
      [1, 2].forEach(streamNum => {
        const stream = streamNum === 1 ? device.stream1 : device.stream2;
        const streamType = stream?.streamType || device.type;
        if (streamType === 'cam-fli') {
          paths.push(`C:\\Ensight\\FLI\\Config\\${device.name}-S${streamNum}.xml`);
        }
      });
    } else if (device.type === 'cam-fli') {
      paths.push(`C:\\Ensight\\FLI\\Config\\${device.name}.xml`);
    }
  } else if (device.type?.startsWith('sign-')) {
    paths.push('C:\\Ensight\\EPIC\\Config\\DevicesConfig.xml');
  } else if (device.type?.startsWith('sensor-')) {
    paths.push('C:\\Ensight\\EPIC\\Config\\DevicesConfig.xml');
  }

  return paths;
};

// ========================= FLI GLOBAL CONFIG =========================

/**
 * Generate FLI Global Config XML (FLI-config.xml)
 * This is a site-wide config that lives under C:\Ensight\FLI\Config\FLI-config.xml
 * @param {Object} options - { siteName, apiHost, apiKey, replicationType }
 */
export const generateFLIGlobalConfig = (options = {}) => {
  const siteName = options.siteName || 'EnsightProject';
  const apiHost = options.apiHost || 'https://data.ensightful.io/v1';
  const apiKey = options.apiKey || 'yRX9QAUNl3aTIMjtK4g5x8rTvkOeUl1KaloJnPCz';
  const replicationType = options.replicationType || 'Primary';
  const dbConnection = options.dbConnectionString || 'Data Source=.\\SQLEXPRESS;Initial Catalog=FliSpyData;Integrated Security=True';
  const metricsHost = options.metricsHost || 'http://metrics.ensightful.io:8080';
  const metricsApp = options.metricsApp || 'FLI';
  const metricsInterval = options.metricsInterval ?? 60;
  const metricsUsername = options.metricsUsername || 'prometheus';
  const metricsPassword = options.metricsPassword || '1qaz2wsx';

  const config = {
    _declaration: { _attributes: { version: '1.0' } },
    FLIGlobalConfig: {
      _attributes: {
        'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance'
      },
      ReplicationType: { _text: replicationType },
      EnsightAPIConfig: {
        Host: { _text: apiHost },
        APIKey: { _text: apiKey }
      },
      DBConnectionString: { _text: dbConnection },
      SiteName: { _text: siteName },
      MetricsServerConfig: {
        Host: { _text: metricsHost },
        ApplicationName: { _text: metricsApp },
        IntervalSeconds: { _text: metricsInterval },
        Username: { _text: metricsUsername },
        Password: { _text: metricsPassword }
      }
    }
  };

  return js2xml(config, XML_OPTIONS);
};

export default {
  generateCameraHubConfig,
  parseCameraHubConfig,
  generateEpicConfiguration,
  generateDevicesConfig,
  parseDevicesConfig,
  generateFLICameraConfig,
  generateFLIGlobalConfig,
  downloadFile,
  readFileAsText,
  exportAllConfigs,
  exportDeviceConfig,
  getConfigFilePaths
};
