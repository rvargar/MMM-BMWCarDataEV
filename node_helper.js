/* MMM-BMWCarData node_helper
 *
 * Patched for compatibility with older MagicMirror (2.9.x, Electron 3 / Node 10):
 *  - falls back to console when the "logger" module alias is not available
 *  - uses node-fetch when the global fetch() is not available
 *  - generates a fresh PKCE verifier/challenge for every login
 *  - requests EV-specific descriptors (BMW iX3 Neue Klasse / BEVs) and parses values null-safe
 *  - vehicle image download is optional (failure no longer blocks the login flow)
 */
const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let Log;
try {
  Log = require("logger");
} catch (e) {
  Log = console;
}

const fetchFn = (typeof fetch === "function") ? fetch : require("node-fetch");

var loggingLevel = 0; // 0: critical, 1: normal, 2: detailed

const bmwApiRoutes = {
  getDeviceCode: {type: 'POST', url: 'https://customer.bmwgroup.com/gcdm/oauth/device/code', headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, addToken: false},
  getToken: {type: 'POST', url: 'https://customer.bmwgroup.com/gcdm/oauth/token', headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, addToken: false},
  createContainer: {type: 'POST', url: 'https://api-cardata.bmwgroup.com/customers/containers', headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'x-version': 'v1'}, addToken: true},
  deleteContainer: {type: 'DELETE', url: 'https://api-cardata.bmwgroup.com/customers/containers', headers: {Accept: '*/*', 'x-version': 'v1'}, addToken: true},
  listContainers: {type: 'GET', url: 'https://api-cardata.bmwgroup.com/customers/containers', headers: {Accept: 'application/json', 'x-version': 'v1'}, addToken: true},
  readVehicleData: {type: 'GET', url: 'https://api-cardata.bmwgroup.com/customers/vehicles', headers: {Accept: 'application/json', 'x-version': 'v1'}, addToken: true},
};

const containerPrefix = 'MM_data'; // prefix of our container name in BMW's CarData API
// Scopes requested at login. The module only uses the REST API; the streaming scope is optional and
// makes BMW reject the login (400 invalid_request) if "CarData Stream" is not enabled for the client ID.
const defaultScope = 'authenticate_user openid cardata:api:read';

// Descriptors requested in the container. Availability varies per model; missing ones come back as null.
const technicalDescriptors = [
  // general
  "vehicle.vehicle.travelledDistance",
  "vehicle.cabin.door.lock.status",
  "vehicle.drivetrain.lastRemainingRange",
  // fuel (ICE / PHEV)
  "vehicle.drivetrain.fuelSystem.remainingFuel",
  "vehicle.drivetrain.fuelSystem.level",
  // electric (BEV / PHEV)
  "vehicle.drivetrain.electricEngine.kombiRemainingElectricRange",
  "vehicle.drivetrain.electricEngine.charging.level",
  "vehicle.drivetrain.batteryManagement.header",
  "vehicle.powertrain.electric.battery.stateOfCharge.displayed",
  "vehicle.powertrain.electric.battery.stateOfCharge.target",
  "vehicle.powertrain.electric.range.target",
  "vehicle.drivetrain.electricEngine.charging.status",
  "vehicle.drivetrain.electricEngine.charging.hvStatus",
  "vehicle.drivetrain.electricEngine.charging.timeRemaining",
  "vehicle.body.chargingPort.status",
  "vehicle.trip.segment.end.drivetrain.batteryManagement.hvSoc",
  // energy / battery
  "vehicle.drivetrain.avgElectricRangeConsumption",
  "vehicle.drivetrain.batteryManagement.maxEnergy",
  "vehicle.powertrain.electric.battery.stateOfHealth.displayed",
  "vehicle.powertrain.electric.battery.preconditioning.state",
  "vehicle.drivetrain.electricEngine.remainingElectricRange",
  // charging details
  "vehicle.powertrain.electric.battery.charging.power",
  "vehicle.drivetrain.electricEngine.charging.timeToFullyCharged",
  "vehicle.drivetrain.electricEngine.charging.method",
  "vehicle.drivetrain.electricEngine.charging.chargingMode",
  "vehicle.drivetrain.electricEngine.charging.acVoltage",
  "vehicle.drivetrain.electricEngine.charging.acAmpere",
  "vehicle.body.chargingPort.dcStatus",
  "vehicle.powertrain.electric.battery.charging.dcChargingModeActive",
  // last trip
  "vehicle.trip.segment.end.time",
  "vehicle.trip.segment.end.travelledDistance",
  "vehicle.trip.segment.accumulated.drivetrain.electricEngine.recuperationTotal",
  "vehicle.trip.segment.accumulated.drivetrain.electricEngine.energyConsumptionComfort",
  "vehicle.trip.segment.accumulated.drivetrain.transmission.setting.fractionDriveEcoPro",
  "vehicle.trip.segment.accumulated.acceleration.starsAverage",
  "vehicle.trip.segment.accumulated.chassis.brake.starsAverage",
  // tyres
  "vehicle.chassis.axle.row1.wheel.left.tire.pressure",
  "vehicle.chassis.axle.row1.wheel.right.tire.pressure",
  "vehicle.chassis.axle.row2.wheel.left.tire.pressure",
  "vehicle.chassis.axle.row2.wheel.right.tire.pressure",
  "vehicle.chassis.axle.row1.wheel.left.tire.pressureTarget",
  "vehicle.chassis.axle.row1.wheel.right.tire.pressureTarget",
  "vehicle.chassis.axle.row2.wheel.left.tire.pressureTarget",
  "vehicle.chassis.axle.row2.wheel.right.tire.pressureTarget",
  "vehicle.chassis.axle.row1.wheel.left.tire.temperature",
  "vehicle.chassis.axle.row1.wheel.right.tire.temperature",
  "vehicle.chassis.axle.row2.wheel.left.tire.temperature",
  "vehicle.chassis.axle.row2.wheel.right.tire.temperature",
];

// BMW containers cannot be modified: the name carries a short hash of the descriptor list,
// so a changed list automatically creates a new container (and the old one is deleted).
const containerName = containerPrefix + '_' + crypto.createHash('sha1').update(technicalDescriptors.join(',')).digest('hex').slice(0, 8);
const WHEELS = {frontLeft: 'row1.wheel.left', frontRight: 'row1.wheel.right', rearLeft: 'row2.wheel.left', rearRight: 'row2.wheel.right'};


var sessionInfoFile = null;
var cacheFile = null;
var containerAttached = {};

function saveCache(self) {
  fs.writeFile(cacheFile, JSON.stringify(self.cache), err => { if (err) { log(0, err); } });
}

function saveSession(self) {
  fs.writeFile(sessionInfoFile, JSON.stringify(self.sessionInfo), err => { if (err) { log(0, err); } });
}

module.exports = NodeHelper.create({
  start: function () {
    log(0, "Starting node_helper for module: " + this.name);
    this.sessionInfo = {};
    this.config = {};
    this.bmwInfo = {};

    sessionInfoFile = path.join(this.path, 'bmw_session_info.json');
    cacheFile = path.join(this.path, 'bmw_cache.json');
    this.cache = {};
    try {
      if (fs.existsSync(cacheFile))
        this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
    } catch (e) {
      this.cache = {};
    }
    log(1, `attempting to load session info from file ${sessionInfoFile}`);
    try {
      if (fs.existsSync(sessionInfoFile)) {
        this.sessionInfo = JSON.parse(fs.readFileSync(sessionInfoFile, 'utf8')) || {};
      }
    } catch (e) {
      log(0, `could not read ${sessionInfoFile}: ${e.message}`);
      this.sessionInfo = {};
    }
  },

  socketNotificationReceived: async function (notification, payload) {
    var self = this;
    var vin = payload.vin;
    if (notification == "MMM-BMWCARDATA-CONFIG") {
      log(1, 'config received from module');
      self.config[vin] = payload;
      if (payload.loggingLevel !== undefined)
        loggingLevel = payload.loggingLevel;
      if (self.sessionInfo[vin] && self.sessionInfo[vin].client_id && self.sessionInfo[vin].client_id !== payload.clientId) {
        log(0, 'client ID changed since last login, a new authorization will be required');
        self.sessionInfo[vin] = {};
      }
      if (!self.sessionInfo[vin])
        self.sessionInfo[vin] = {};
      self.sessionInfo[vin].client_id = payload.clientId;
      self.bmwInfo[vin] = {error: null};
    } else if (notification == "MMM-BMWCARDATA-GET") {
      if (self.busy && self.busy[vin]) {
        log(1, 'update already in progress for ' + vin + ', skipping');
        return;
      }
      self.busy = self.busy || {};
      self.busy[vin] = true;
      try {
        await self.updateVehicle(payload);
      } catch (e) {
        log(0, 'unexpected error while updating: ' + (e && e.stack ? e.stack : e));
      }
      self.busy[vin] = false;
    }
  },

  updateVehicle: async function (payload) {
    const vin = payload.vin;
    log(1, 'Updating data for ' + vin);
    const res = await getTelematicData(this, vin);
    if (!res || !res.data || !res.data.telematicData) {
      log(0, 'no telematic data received, nothing sent to module');
      if (!this.bmwInfo[vin] || !this.bmwInfo[vin].updateTime)
        this.sendSocketNotification("MMM-BMWCARDATA-RESPONSE" + payload.instanceId, {error: 'No data from BMW yet, see MagicMirror log.'});
      return;
    }
    log(1, 'telematic data: ' + JSON.stringify(res.data));
    const t = res.data.telematicData;
    const info = this.bmwInfo[vin] || {};

    const lock = val(t, "vehicle.cabin.door.lock.status");
    info.doorLock = (lock === 'SECURED' || lock === 'LOCKED');
    info.doorLockKnown = (lock !== null);
    info.mileage = num(t, "vehicle.vehicle.travelledDistance");
    info.electricRange = num(t, "vehicle.drivetrain.electricEngine.kombiRemainingElectricRange");
    if (info.electricRange === null)
      info.electricRange = num(t, "vehicle.powertrain.electric.range.target");
    info.chargingLevelHv = firstNum(t, [
      "vehicle.powertrain.electric.battery.stateOfCharge.displayed",
      "vehicle.drivetrain.batteryManagement.header",
      "vehicle.drivetrain.electricEngine.charging.level",
    ]);
    info.chargingTarget = num(t, "vehicle.powertrain.electric.battery.stateOfCharge.target");
    // lastRemainingRange is the total range; for a BEV it equals the electric range, so only use it as fuel range if fuel data exists
    const fuelLevel = num(t, "vehicle.drivetrain.fuelSystem.level");
    const remainingFuel = num(t, "vehicle.drivetrain.fuelSystem.remainingFuel");
    info.totalRange = num(t, "vehicle.drivetrain.lastRemainingRange");
    info.fuelRange = (fuelLevel || remainingFuel) ? info.totalRange : null;

    const chargingStatus = String(val(t, "vehicle.drivetrain.electricEngine.charging.status") || val(t, "vehicle.drivetrain.electricEngine.charging.hvStatus") || '').toUpperCase();
    const portStatus = String(val(t, "vehicle.body.chargingPort.status") || '').toUpperCase();
    info.charging = /CHARGINGACTIVE|^CHARGING$/.test(chargingStatus);
    info.connectorStatus = info.charging || (portStatus.indexOf('CONNECTED') !== -1 && portStatus.indexOf('DISCONNECTED') === -1);
    info.chargingStatus = chargingStatus || null;
    info.chargingTimeRemaining = num(t, "vehicle.drivetrain.electricEngine.charging.timeRemaining");

    try {
      info.ext = await buildExtended(this, vin, t, info);
    } catch (e) {
      log(0, 'could not build extended data: ' + (e && e.stack ? e.stack : e));
      info.ext = null;
    }

    const imageFile = path.join(this.path, 'car-' + vin + '.png');
    info.imageUrl = fs.existsSync(imageFile) ? 'modules/MMM-BMWCarData/car-' + vin + '.png' : null;
    info.updateTime = Date.now();
    info.error = null;
    this.bmwInfo[vin] = info;
    log(2, 'sending to module: ' + JSON.stringify(info));
    this.sendSocketNotification("MMM-BMWCARDATA-RESPONSE" + payload.instanceId, info);
  },
});

function entry(t, key) {
  return (t && t[key]) ? t[key] : {};
}

function tsMs(v) {
  // BMW uses ISO strings, epoch seconds or epoch milliseconds depending on the endpoint
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = Date.parse(String(v).replace(' UTC', 'Z'));
  return isNaN(d) ? null : d;
}

function round(v, digits) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = Math.pow(10, digits || 0);
  return Math.round(v * f) / f;
}

function minutesSince(ms) {
  return ms ? (Date.now() - ms) / 60000 : Infinity;
}

// Calls a dedicated endpoint at most every `intervalMin` minutes; result is cached on disk to survive restarts.
async function cachedEndpoint(self, vin, key, intervalMin, endpoint) {
  self.cache[vin] = self.cache[vin] || {};
  const c = self.cache[vin][key];
  if (c && minutesSince(c.fetchedAt) < intervalMin)
    return c.data;
  const res = await bmwApiCall(self, vin, bmwApiRoutes.readVehicleData, '/' + vin + endpoint);
  log(1, `Status ${res.status} on BMW API call ${endpoint.split('?')[0]}`);
  if (res.status === 200 && res.data) {
    log(2, key + ': ' + JSON.stringify(res.data));
    self.cache[vin][key] = {fetchedAt: Date.now(), data: res.data};
  } else {
    log(0, `${key} not available: ${res.status} ${JSON.stringify(res.body || res.error || '')}`);
    // don't retry before the next interval, to protect the daily API quota
    self.cache[vin][key] = {fetchedAt: Date.now(), data: c ? c.data : null};
  }
  saveCache(self);
  return self.cache[vin][key].data;
}

function lastChargingSession(history) {
  const list = (history && history.data) || [];
  let best = null;
  list.forEach(function (sess) {
    if (!best || (tsMs(sess.endTime) || 0) > (tsMs(best.endTime) || 0)) best = sess;
  });
  if (!best) return null;
  const durMin = best.totalChargingDurationSec ? best.totalChargingDurationSec / 60 : null;
  let peakKw = null;
  (best.chargingBlocks || []).forEach(function (b) {
    if (b.averagePowerGridKw !== undefined && b.averagePowerGridKw !== null && (peakKw === null || b.averagePowerGridKw > peakKw)) peakKw = b.averagePowerGridKw;
  });
  const energy = (best.energyConsumedFromPowerGridKwh !== undefined && best.energyConsumedFromPowerGridKwh !== null) ? best.energyConsumedFromPowerGridKwh : null;
  const loc = best.chargingLocation || {};
  return {
    endTime: tsMs(best.endTime),
    startSoc: best.displayedStartSoc !== undefined ? best.displayedStartSoc : null,
    endSoc: best.displayedSoc !== undefined ? best.displayedSoc : null,
    energyKwh: round(energy, 1),
    durationMin: durMin !== null ? Math.round(durMin) : null,
    avgKw: (energy && durMin) ? round(energy / (durMin / 60), 1) : null,
    peakKw: round(peakKw, 1),
    location: loc.municipality || loc.formattedAddress || null,
    isPublic: !!best.publicChargingPoint
  };
}

function tyreDiagnosisSummary(diag) {
  const mounted = diag && diag.passengerCar && diag.passengerCar.mountedTyres;
  if (!mounted) return null;
  const out = {overall: mounted.aggregatedQualityStatus ? (mounted.aggregatedQualityStatus.qualityStatus || mounted.aggregatedQualityStatus.value || null) : null, wheels: {}};
  Object.keys(WHEELS).forEach(function (w) {
    const d = mounted[w];
    if (!d) return;
    out.wheels[w] = {
      wearColor: d.tyreWear ? d.tyreWear.statusColor || null : null,
      dueMileage: d.tyreWear ? (d.tyreWear.dueMileage !== undefined ? d.tyreWear.dueMileage : null) : null,
      defectColor: d.tyreDefect ? d.tyreDefect.statusColor || null : null,
      season: d.season ? d.season.value || null : null
    };
  });
  return out;
}

async function buildExtended(self, vin, t, info) {
  const cfg = self.config[vin] || {};
  const ext = {};
  self.cache[vin] = self.cache[vin] || {};

  // energy / battery
  ext.avgConsumption = num(t, "vehicle.drivetrain.avgElectricRangeConsumption");
  ext.avgConsumptionUnit = entry(t, "vehicle.drivetrain.avgElectricRangeConsumption").unit || null;
  ext.maxEnergy = round(num(t, "vehicle.drivetrain.batteryManagement.maxEnergy"), 1);
  ext.stateOfHealth = num(t, "vehicle.powertrain.electric.battery.stateOfHealth.displayed");
  ext.batteryPreconditioning = val(t, "vehicle.powertrain.electric.battery.preconditioning.state");

  // charging now
  let power = num(t, "vehicle.powertrain.electric.battery.charging.power");
  if (power !== null && Math.abs(power) > 500) power = power / 1000; // catalogue unit is W
  ext.chargingPowerKw = round(power, 1);
  ext.chargingTarget = info.chargingTarget;
  ext.chargingMethod = val(t, "vehicle.drivetrain.electricEngine.charging.method");
  const dc = String(val(t, "vehicle.body.chargingPort.dcStatus") || '').toUpperCase();
  ext.chargingType = (dc.indexOf('CONNECTED') !== -1 && dc.indexOf('DISCONNECTED') === -1) ? 'DC' : (info.connectorStatus ? 'AC' : null);
  ext.acVoltage = num(t, "vehicle.drivetrain.electricEngine.charging.acVoltage");
  ext.acAmpere = num(t, "vehicle.drivetrain.electricEngine.charging.acAmpere");
  let remainingKey = "vehicle.drivetrain.electricEngine.charging.timeRemaining";
  let remaining = num(t, remainingKey);
  if (!remaining) {
    remainingKey = "vehicle.drivetrain.electricEngine.charging.timeToFullyCharged";
    remaining = num(t, remainingKey);
  }
  ext.chargingTimeRemaining = remaining;
  ext.chargingEta = (info.charging && remaining) ? (tsMs(entry(t, remainingKey).timestamp) || Date.now()) + remaining * 60000 : null;

  // last trip
  const tripEndOdo = num(t, "vehicle.trip.segment.end.travelledDistance");
  const tripEndTime = tsMs(val(t, "vehicle.trip.segment.end.time")) || tsMs(entry(t, "vehicle.trip.segment.end.drivetrain.batteryManagement.hvSoc").timestamp);
  const trip = self.cache[vin].trip || {};
  if (tripEndOdo !== null && tripEndOdo !== trip.endOdo) {
    // a new trip was logged since the last poll: distance = difference of end mileages
    trip.distance = (trip.endOdo !== undefined && trip.endOdo !== null && tripEndOdo > trip.endOdo) ? round(tripEndOdo - trip.endOdo, 1) : null;
    trip.endOdo = tripEndOdo;
    self.cache[vin].trip = trip;
    saveCache(self);
  }
  ext.trip = {
    endTime: tripEndTime,
    distance: trip.distance !== undefined ? trip.distance : null,
    endSoc: num(t, "vehicle.trip.segment.end.drivetrain.batteryManagement.hvSoc"),
    recuperation: round(num(t, "vehicle.trip.segment.accumulated.drivetrain.electricEngine.recuperationTotal"), 1),
    comfortEnergy: round(num(t, "vehicle.trip.segment.accumulated.drivetrain.electricEngine.energyConsumptionComfort"), 1),
    ecoPro: round(num(t, "vehicle.trip.segment.accumulated.drivetrain.transmission.setting.fractionDriveEcoPro"), 0),
    accelStars: round(num(t, "vehicle.trip.segment.accumulated.acceleration.starsAverage"), 1),
    brakeStars: round(num(t, "vehicle.trip.segment.accumulated.chassis.brake.starsAverage"), 1)
  };

  // tyres (pressures in kPa -> bar)
  const toBar = function (key) {
    const v = num(t, key);
    if (v === null) return null;
    const unit = String(entry(t, key).unit || '').toLowerCase();
    return round(unit === 'bar' || v < 20 ? v : v / 100, 1);
  };
  ext.tyres = {};
  Object.keys(WHEELS).forEach(function (w) {
    const base = "vehicle.chassis.axle." + WHEELS[w] + ".tire.";
    ext.tyres[w] = {pressure: toBar(base + "pressure"), target: toBar(base + "pressureTarget"), temperature: num(t, base + "temperature")};
  });

  // dedicated endpoints, rate-limited
  if (cfg.showLastCharge !== false) {
    const to = new Date();
    const from = new Date(to.getTime() - (cfg.chargingHistoryDays || 30) * 86400000);
    const hist = await cachedEndpoint(self, vin, 'chargingHistory', cfg.chargingHistoryRefresh || 360,
      '/chargingHistory?from=' + encodeURIComponent(from.toISOString()) + '&to=' + encodeURIComponent(to.toISOString()));
    ext.lastCharge = lastChargingSession(hist);
  }
  if (cfg.showTyres !== false) {
    const diag = await cachedEndpoint(self, vin, 'tyreDiagnosis', cfg.tyreDiagnosisRefresh || 720, '/smartMaintenanceTyreDiagnosis');
    ext.tyreDiagnosis = tyreDiagnosisSummary(diag);
  }
  return ext;
}

function val(t, key) {
  if (!t || !t[key] || t[key].value === undefined || t[key].value === null || t[key].value === '')
    return null;
  return t[key].value;
}

function num(t, key) {
  const v = val(t, key);
  if (v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function firstNum(t, keys) {
  for (var i = 0; i < keys.length; i++) {
    const n = num(t, keys[i]);
    if (n !== null) return n;
  }
  return null;
}

function log(level, message) {
  if (level <= loggingLevel)
    Log.log('MMM-BMWCarData helper: ' + message);
}

function sendError(self, error) {
  log(0, 'message sent to module: ' + error);
  self.sendSocketNotification("MMM-BMWCARDATA-ERROR", error);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAccessToken(self, vin) {
  log(1, 'getAccessToken() called');
  const s = self.sessionInfo[vin];
  const currentTime = Date.now();
  if (!s || !s.token_expiry || !s.refresh_token || (s.refresh_expiry < currentTime)) {
    log(0, 'no valid refresh token, interactive authorization on the BMW portal is required');
    let res = await getDeviceCode(self, vin);
    if (!res || !res.data)
      return {error: 'could not obtain device code'};
    saveSession(self);
    const uri = res.data.verification_uri_complete || res.data.verification_uri;
    log(0, `Please visit ${uri} within the next ${res.data.expires_in} seconds, log in (if required), and enter the following code: ${res.data.user_code}`);
    sendError(self, `Authorization required. Visit <br>${res.data.verification_uri}<br> within ${res.data.expires_in} seconds<br>Code: ${res.data.user_code}`);
    res = await getFirstToken(self, vin, res.data);
    if (!res || !res.data) {
      sendError(self, 'BMW authorization not completed. Will retry at next refresh.');
      return {error: 'could not obtain first token'};
    }
    // vehicle image is optional
    try {
      await getVehicleImage(self, vin);
    } catch (e) {
      log(0, 'could not retrieve vehicle image: ' + e.message);
    }
    res = await attachContainer(self, vin, true); // on re-authentication, re-create the container so it contains what we expect
    if (!res || !res.data)
      return {error: 'could not create container'};
    sendError(self, ''); // clear the authorization instructions
    log(0, 'BMW authorization successful');
    return {data: self.sessionInfo[vin].access_token};
  }
  if (s.token_expiry < currentTime + 60 * 1000) {
    log(1, 'access token expired, refreshing');
    const res = await refreshToken(self, vin);
    if (!res || !res.data)
      return {error: 'could not refresh token'};
    return {data: s.access_token};
  }
  return {data: s.access_token};
}

async function getDeviceCode(self, vin) {
  log(1, 'getDeviceCode() called');
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  self.sessionInfo[vin].code_verifier = verifier;
  const body = new URLSearchParams({
    client_id: self.sessionInfo[vin].client_id,
    response_type: 'device_code',
    scope: (self.config[vin] && self.config[vin].scope) || defaultScope,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString();
  const res = await bmwApiCall(self, vin, bmwApiRoutes.getDeviceCode, '', body);
  if (res.status != 200 || !res.data) {
    log(0, `Error status ${res.status} on BMW API call to obtain device code: ${JSON.stringify(res.body || res.error || '')}`);
    log(0, 'Check that the client ID is correct and that "Request access to CarData API" is enabled for it in the BMW CarData portal.');
    sendError(self, 'BMW login could not be started (' + res.status + ' ' + ((res.body && res.body.error) || res.error || '') + ').<br>Check client ID and CarData API access in the BMW portal.');
    return;
  }
  self.sessionInfo[vin].device_code = res.data.device_code;
  return {data: res.data};
}

function storeTokens(self, vin, data) {
  const s = self.sessionInfo[vin];
  s.access_token = data.access_token;
  if (data.refresh_token) s.refresh_token = data.refresh_token;
  if (data.id_token) s.id_token = data.id_token;
  if (data.gcid) s.gcid = data.gcid;
  s.token_expiry = Date.now() + (data.expires_in || 3600) * 1000;
  s.refresh_expiry = Date.now() + 1209600 * 1000; // BMW: refresh token valid for two weeks
  saveSession(self);
}

async function getFirstToken(self, vin, deviceData) {
  // poll until the user has entered the code on the BMW website, or the code expires
  const intervalSec = Math.max(deviceData.interval || 5, 5);
  const deadline = Date.now() + (deviceData.expires_in || 300) * 1000;
  const body = new URLSearchParams({
    client_id: self.sessionInfo[vin].client_id,
    device_code: self.sessionInfo[vin].device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    code_verifier: self.sessionInfo[vin].code_verifier
  }).toString();
  let wait = intervalSec;
  while (Date.now() < deadline) {
    await sleep(wait * 1000);
    const res = await bmwApiCall(self, vin, bmwApiRoutes.getToken, '', body);
    if (res.status === 200 && res.data && res.data.access_token) {
      storeTokens(self, vin, res.data);
      return {data: res.data};
    }
    const err = res.body && res.body.error;
    log(1, `polling for token: status ${res.status} ${err || ''}`);
    if (err === 'slow_down') wait += 5;
    else if (err && err !== 'authorization_pending') {
      log(0, `authorization failed: ${JSON.stringify(res.body)}`);
      return {error: err};
    }
  }
  log(0, 'device code expired before authorization was completed');
  return {error: 'expired'};
}

async function refreshToken(self, vin) {
  log(1, 'refreshToken() called');
  const body = new URLSearchParams({
    client_id: self.sessionInfo[vin].client_id,
    refresh_token: self.sessionInfo[vin].refresh_token,
    grant_type: 'refresh_token',
  }).toString();
  const res = await bmwApiCall(self, vin, bmwApiRoutes.getToken, '', body);
  if (res.status === 200 && res.data && res.data.access_token) {
    storeTokens(self, vin, res.data);
    return {data: res.data};
  }
  log(0, `refreshing token failed (status ${res.status}), a new authorization will be required`);
  self.sessionInfo[vin].refresh_token = null;
  saveSession(self);
  return {error: 'refresh failed'};
}

async function listContainers(self, vin) {
  const res = await bmwApiCall(self, vin, bmwApiRoutes.listContainers);
  log(1, `Status ${res.status} on BMW API call to list containers`);
  if (res.status === 200 && res.data)
    return {data: res.data};
  log(0, `listing containers failed: ${res.status} ${JSON.stringify(res.body || '')}`);
}

async function createContainer(self, vin) {
  const body = JSON.stringify({
    name: containerName,
    purpose: "data for display on Magic Mirror MMM-BMWCarData module",
    technicalDescriptors: technicalDescriptors
  });
  const res = await bmwApiCall(self, vin, bmwApiRoutes.createContainer, '', body);
  log(1, `Status ${res.status} on BMW API call to create container`);
  if ((res.status === 201 || res.status === 200) && res.data && res.data.containerId) {
    self.sessionInfo[vin].container_id = res.data.containerId;
    self.sessionInfo[vin].container_name = containerName;
    containerAttached[vin] = true;
    saveSession(self);
    return {data: res.data};
  }
  log(0, `creating container failed: ${res.status} ${JSON.stringify(res.body || '')}`);
}

async function attachContainer(self, vin, forceDelete) {
  if (containerAttached[vin] && !forceDelete && self.sessionInfo[vin].container_name === containerName)
    return {data: self.sessionInfo[vin].container_id};
  let res = await listContainers(self, vin);
  if (!res || !res.data)
    return {error: 'listContainers() failed'};
  const containers = res.data.containers || [];
  for (var i = 0; i < containers.length; i++) {
    const cname = containers[i].name || '';
    if (cname.indexOf(containerPrefix) === 0 && cname !== containerName && containers[i].state !== 'DELETED') {
      log(0, `deleting outdated container ${cname} (descriptor list changed)`);
      await bmwApiCall(self, vin, bmwApiRoutes.deleteContainer, '/' + containers[i].containerId);
      continue;
    }
    if ((cname === containerName) && (containers[i].state !== 'DELETED')) {
      if (forceDelete) {
        log(1, 'existing container found, deleting before re-creating');
        self.sessionInfo[vin].container_id = containers[i].containerId;
        await deleteContainer(self, vin);
      } else {
        log(1, 'existing container found, will use it');
        self.sessionInfo[vin].container_id = containers[i].containerId;
        self.sessionInfo[vin].container_name = containerName;
        containerAttached[vin] = true;
        saveSession(self);
        return {data: self.sessionInfo[vin].container_id};
      }
    }
  }
  res = await createContainer(self, vin);
  if (!res || !res.data)
    return {error: 'createContainer() failed'};
  return {data: self.sessionInfo[vin].container_id};
}

async function deleteContainer(self, vin) {
  const res = await bmwApiCall(self, vin, bmwApiRoutes.deleteContainer, '/' + self.sessionInfo[vin].container_id);
  log(1, `Status ${res.status} on BMW API call to delete container`);
  if (res.status === 204 || res.status === 200)
    return {data: 'success'};
}

async function getTelematicData(self, vin) {
  const token = await getAccessToken(self, vin);
  if (!token || !token.data)
    return;
  if (!containerAttached[vin] || !self.sessionInfo[vin].container_id || self.sessionInfo[vin].container_name !== containerName) {
    const c = await attachContainer(self, vin);
    if (!c || !c.data) return;
  }
  const res = await bmwApiCall(self, vin, bmwApiRoutes.readVehicleData, '/' + vin + '/telematicData?containerId=' + self.sessionInfo[vin].container_id);
  log(1, `Status ${res.status} on BMW API call to retrieve telematic data`);
  if (res.status === 200 && res.data)
    return {data: res.data};
  if (res.status === 404 || res.status === 403) {
    // container may have been removed in the portal: re-attach next time
    containerAttached[vin] = false;
  }
  log(0, `retrieving telematic data failed: ${res.status} ${JSON.stringify(res.body || '')}`);
}

async function getVehicleImage(self, vin) {
  const downloadPath = path.join(self.path, 'car-' + vin + '.png');
  if (fs.existsSync(downloadPath)) {
    log(1, 'vehicle image already available');
    return {data: downloadPath};
  }
  const token = await getAccessToken(self, vin);
  const res = await fetchFn(bmwApiRoutes.readVehicleData.url + '/' + vin + '/image', {
    method: 'GET',
    headers: {Accept: '*/*', 'x-version': 'v1', Authorization: 'Bearer ' + token.data}
  });
  if (res.status !== 200) {
    log(0, 'vehicle image not available (status ' + res.status + ')');
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(downloadPath, buf);
  log(1, 'saved vehicle image to ' + downloadPath);
  return {data: downloadPath};
}

async function bmwApiCall(self, vin, route, endpoint, body) {
  const fullRoute = endpoint ? route.url + endpoint : route.url;
  try {
    log(1, 'calling BMW API at ' + fullRoute);
    const headers = Object.assign({}, route.headers);
    if (route.addToken) {
      const token = await getAccessToken(self, vin);
      if (!token || !token.data)
        return {status: 0, data: null, error: 'no access token'};
      headers.Authorization = 'Bearer ' + token.data;
    }
    const res = await fetchFn(fullRoute, {method: route.type, headers: headers, body: body});
    log(1, 'status: ' + res.status);
    const contentType = res.headers.get('content-type') || '';
    let parsed = null;
    if (res.status !== 204) {
      const text = await res.text();
      if (contentType.indexOf('json') !== -1) {
        try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
      } else {
        parsed = text;
      }
    }
    if (res.status >= 300)
      return {status: res.status, data: null, body: parsed};
    return {status: res.status, data: parsed};
  } catch (e) {
    log(0, `BMW API call error: ${e.message}`);
    return {status: 0, data: null, error: e.message};
  }
}
