 
Module.register("MMM-BMWCarData", {
  defaults: {
    refresh: 60,
    vehicleOpacity: 0.75,
    useUSUnits: false,
    showMileage: true,
    showElectricPercentage: true,
    showElectricRange: true,
    showFuelRange: true,
    fuelRangeWarning: 100,
    fuelRangeCritical: 50,
    showLastUpdated: true,
    lastUpdatedText: "last updated",
    // extended EV telemetry panel (below "last updated")
    showConsumption: true,      // average consumption, battery health, usable capacity
    consumptionSource: "auto",  // "auto": BMW value if valid, else calculated; "calculated": always calculate
    consumptionWindowKm: 300,   // calculated average covers the last N km
    consumptionMinKm: 20,       // show calculated average after this many km
    showCharging: true,         // live charging power, type, target, ETA (only while plugged in)
    showLastCharge: true,       // last session from BMW charging history
    showTrip: true,             // last trip info
    showTyres: true,            // tyre pressures (+ wear status from BMW tyre diagnosis)
    tyrePressureUnit: "bar",    // "bar" or "psi"
    tyreWarningDelta: 0.2,      // bar below target -> orange
    tyreCriticalDelta: 0.4,     // bar below target -> red
    chargingHistoryRefresh: 360,// minutes between charging-history calls (API quota: 50/day)
    tyreDiagnosisRefresh: 720   // minutes between tyre-diagnosis calls
  },

  getStyles: function () {
    return ["MMM-BMWCarData.css"];
  },

  getScripts: function () {
    return ["moment.js"];
  },

  start: function () {
    Log.info("Starting module: " + this.name);
    this.sendSocketNotification("MMM-BMWCARDATA-CONFIG", this.config);
    this.bmwInfo = {};
    this.getInfo();
    self = this;
    this.updateTimer = setInterval(function(){self.getInfo()}, this.config.refresh * 60 * 1000);
    this.refreshTimer = setInterval(function(){self.updateDom(0)}, 30000); // Update DOM more often for "last updated" field to refresh.
  },

  getInfo: function () {
    this.sendSocketNotification("MMM-BMWCARDATA-GET", {
	    instanceId: this.identifier,
	    vin: this.config.vin
    });
  },

  socketNotificationReceived: function (notification, payload) {
    if (
      notification === "MMM-BMWCARDATA-RESPONSE" + this.identifier &&
      Object.keys(payload).length > 0
    ) {
      this.bmwInfo = payload;
      if (this.config.useUSUnits) {
          var toMi = function (v) { return (v === null || v === undefined) ? v : Math.round(v / 1.60934); };
          this.bmwInfo.mileage = toMi(this.bmwInfo.mileage);
          this.bmwInfo.electricRange = toMi(this.bmwInfo.electricRange);
          this.bmwInfo.fuelRange = toMi(this.bmwInfo.fuelRange);
      }
      this.error=null;
      this.updateDom(1000);
    }
    if (notification === "MMM-BMWCARDATA-ERROR") {
      if (Object.keys(payload).length > 0) {        
        this.error = payload;
        this.updateDom(1000);
        setTimeout(() => {this.error=null;this.updateDom(1000);}, 5*60*1000) // errors get cleared automatically after 5 minutes, or when regular data is received
      } else {
        this.error = 'clearing error';
        this.updateDom(1000);
        setTimeout(() => {this.error=null;this.updateDom(1000);}, 1000) 
      }
    }
  },

  faIconFactory: function (icon, color) {
    var faIcon = document.createElement("i");
    faIcon.classList.add("fas");
    faIcon.classList.add(icon);
    if(color)
      faIcon.style.color=color;
    return faIcon;
  },

  getDom: function () {
    var wrapper = document.createElement("div");
	  wrapper.classList.add("bmw-wrapper");

    if (this.config.vin === "") {
      wrapper.innerHTML = "Missing configuration.";
      return wrapper;
    }

    if (!!this.error) {
      wrapper.innerHTML = this.error;
      wrapper.className = "bright light small";
      return wrapper;
    }

    if (Object.keys(this.bmwInfo).length === 0) {
      wrapper.innerHTML = this.translate("LOADING");
      wrapper.className = "dimmed light small";
      return wrapper;
    }

    if (!!this.bmwInfo.error) {
	  wrapper.innerHTML = this.bmwInfo.error;
      wrapper.className = "dimmed light small";
      return wrapper;
    }

    let info = this.bmwInfo;
    var has = function (v) { return v !== null && v !== undefined && v !== ''; };

    var carContainer = document.createElement("div");
    carContainer.classList.add("bmw-container");

    if (info.imageUrl) {
      var imageContainer = document.createElement("span");
      var imageObject = document.createElement("img");
      imageObject.setAttribute('src', info.imageUrl);
      imageObject.setAttribute('style', 'opacity: ' + this.config.vehicleOpacity + ';');
      imageContainer.appendChild(imageObject);
      carContainer.appendChild(imageContainer);
      wrapper.appendChild(carContainer);
    }

    carContainer = document.createElement("div");
    carContainer.classList.add("bmw-container");

    var battery = document.createElement("span");
    battery.classList.add("battery");
    
    if (this.config.showElectricPercentage && has(info.chargingLevelHv)) {
      var plugged = document.createElement("span");
      plugged.classList.add("plugged");

      if (info.charging) {
        plugged.appendChild(this.faIconFactory("fa-bolt", "#5cbc82"));
      } else if (info.connectorStatus) {
        plugged.appendChild(this.faIconFactory("fa-plug"));
      } else {
        //plugged.appendChild(this.faIconFactory("fa-plug"));
        plugged.appendChild(document.createTextNode("\u00a0"));
      }
      battery.appendChild(plugged);

      switch (true) {
        case (info.chargingLevelHv < 25):
          battery.appendChild(this.faIconFactory("fa-battery-empty"));
          break;
        case (info.chargingLevelHv < 50):
          battery.appendChild(this.faIconFactory("fa-battery-quarter"));
          break;
        case (info.chargingLevelHv < 75):
          battery.appendChild(this.faIconFactory("fa-battery-half"));
          break;
        case (info.chargingLevelHv < 100):
          battery.appendChild(this.faIconFactory("fa-battery-three-quarters"));
          break;
        default:
          battery.appendChild(this.faIconFactory("fa-battery-full"));
          break;
      }

      battery.appendChild(document.createTextNode(info.chargingLevelHv + " %"));
    } else {
      battery.appendChild(document.createTextNode("⠀")); // For spacing
    }
    carContainer.appendChild(battery);
    wrapper.appendChild(carContainer);

    var mileage = document.createElement("span");
    mileage.classList.add("mileage");
    if (this.config.showMileage && has(info.mileage)) {
      mileage.appendChild(this.faIconFactory("fa-road"));
      mileage.appendChild(document.createTextNode(info.mileage + (this.config.useUSUnits ? ' mi' : ' km')));
    } else {
      mileage.appendChild(document.createTextNode("\u00a0"));
    }
    carContainer.appendChild(mileage);
    wrapper.appendChild(carContainer);

    carContainer = document.createElement("div");
    carContainer.classList.add("bmw-container");

    var elecRange = document.createElement("span");
    elecRange.classList.add("elecRange");
    if (this.config.showElectricRange && has(info.electricRange)) {
      elecRange.appendChild(this.faIconFactory("fa-charging-station"));
      elecRange.appendChild(document.createTextNode(info.electricRange + (this.config.useUSUnits ? ' mi' : ' km')));
    } else {
      elecRange.appendChild(document.createTextNode("\u00a0"));
    }
    carContainer.appendChild(elecRange);
    wrapper.appendChild(carContainer);

    carContainer = document.createElement("div");
    carContainer.classList.add("bmw-container");
    carContainer.classList.add("spacer");
    wrapper.appendChild(carContainer);

    carContainer = document.createElement("div");
    carContainer.classList.add("bmw-container");

    var locked = document.createElement("span");
    locked.classList.add("locked");
    if (info.doorLockKnown === false) {
      locked.appendChild(document.createTextNode(" "));
    } else if (info.doorLock) {
      locked.appendChild(this.faIconFactory("fa-lock"));
    } else {
      locked.appendChild(this.faIconFactory("fa-lock-open"));
    }
    carContainer.appendChild(locked);
    
    var fuelRange = document.createElement("span");
    fuelRange.classList.add("fuelRange");
    if ((this.config.showFuelRange) && has(info.fuelRange)) {
      if(info.fuelRange<this.config.fuelRangeCritical)
        fuelRange.appendChild(this.faIconFactory("fa-gas-pump","red"));
      else
        if(info.fuelRange<this.config.fuelRangeWarning)
          fuelRange.appendChild(this.faIconFactory("fa-gas-pump","orange"));
        else
          fuelRange.appendChild(this.faIconFactory("fa-gas-pump"));
      fuelRange.appendChild(document.createTextNode(info.fuelRange + (this.config.useUSUnits ? ' mi' : ' km')));
    } else {
      fuelRange.appendChild(document.createTextNode("\u00a0"));
    }
    carContainer.appendChild(fuelRange);
    wrapper.appendChild(carContainer);
    
    carContainer = document.createElement("div");
    carContainer.classList.add("bmw-container");
    carContainer.classList.add("updated");
    
    var updated = document.createElement("span");
    updated.classList.add("updated");
    if (this.config.showLastUpdated) {
      updated.appendChild(this.faIconFactory("fa-info"));
      var lastUpdateText = this.config.lastUpdatedText + " " + moment(info.updateTime).fromNow();
    } else {
      lastUpdateText = "";
    }
    updated.appendChild(document.createTextNode(lastUpdateText));
    carContainer.appendChild(updated);
    wrapper.appendChild(carContainer);

    if (info.ext)
      wrapper.appendChild(this.getExtendedDom(info));

    return wrapper;
  },

  // ---------- extended telemetry panel ----------

  fmtTime: function (ms) {
    if (!ms) return null;
    var m = moment(ms);
    if (m.isSame(moment(), 'day')) return m.format('HH:mm');
    if (m.isSame(moment().subtract(1, 'day'), 'day')) return this.translate('YESTERDAY') !== 'YESTERDAY' ? this.translate('YESTERDAY') + ' ' + m.format('HH:mm') : m.format('ddd HH:mm');
    return m.format('D MMM HH:mm');
  },

  fmtDuration: function (min) {
    if (min === null || min === undefined) return null;
    min = Math.round(min);
    var h = Math.floor(min / 60), mm = min % 60;
    return h > 0 ? h + ' h ' + (mm < 10 ? '0' : '') + mm + ' min' : mm + ' min';
  },

  extRow: function (icon, left, right, sub, iconColor) {
    var row = document.createElement("div");
    row.classList.add("bmw-ext-row");
    var l = document.createElement("span");
    l.classList.add("bmw-ext-left");
    l.appendChild(this.faIconFactory(icon, iconColor));
    l.appendChild(document.createTextNode(left));
    row.appendChild(l);
    if (right) {
      var r = document.createElement("span");
      r.classList.add("bmw-ext-right");
      r.appendChild(document.createTextNode(right));
      row.appendChild(r);
    }
    if (sub) {
      var s = document.createElement("div");
      s.classList.add("bmw-ext-sub", "dimmed");
      s.appendChild(document.createTextNode(sub));
      row.appendChild(s);
    }
    return row;
  },

  getExtendedDom: function (info) {
    var self = this, e = info.ext, c = this.config;
    var has = function (v) { return v !== null && v !== undefined && v !== ''; };
    var join = function (arr) { return arr.filter(has).join(' \u00b7 '); };
    // sub-lines may wrap, but never inside one item
    var joinNb = function (arr) { return arr.filter(has).map(function (x) { return String(x).replace(/ /g, '\u00a0'); }).join(' \u00b7 '); };
    var box = document.createElement("div");
    box.classList.add("bmw-container", "bmw-ext");

    // energy / battery
    if (c.showConsumption && (has(e.avgConsumption) || has(e.stateOfHealth) || has(e.maxEnergy))) {
      var unit = e.avgConsumptionUnit && e.avgConsumptionUnit.indexOf('mi') !== -1 ? ' mi/kWh' : ' kWh/100km';
      var consText = has(e.avgConsumption)
        ? '\u2300 ' + e.avgConsumption + unit + (e.avgConsumptionCalculated ? ' calc.' : '')
        : (e.avgConsumptionCalculated && has(e.consumptionKmTracked) ? '\u2300 after ' + e.consumptionKmNeeded + ' km' : '\u00a0');
      box.appendChild(this.extRow("fa-tachometer-alt",
        consText,
        has(e.stateOfHealth) ? 'SoH ' + e.stateOfHealth + ' %' : null,
        has(e.maxEnergy) ? 'usable battery ' + e.maxEnergy + ' kWh' : null));
    }

    // live charging (only when plugged in / charging)
    if (c.showCharging && (info.charging || info.connectorStatus)) {
      var left = info.charging
        ? (has(e.chargingPowerKw) ? e.chargingPowerKw + ' kW' : 'Charging') + (e.chargingType ? ' ' + e.chargingType : '')
        : 'Plugged in' + (e.chargingType ? ' (' + e.chargingType + ')' : '');
      var right = join([has(info.chargingLevelHv) && has(e.chargingTarget) ? info.chargingLevelHv + '\u2192' + e.chargingTarget + ' %' : null,
                        e.chargingEta ? this.fmtTime(e.chargingEta) : null]);
      var sub = info.charging ? joinNb([has(e.chargingTimeRemaining) ? this.fmtDuration(e.chargingTimeRemaining) + ' left' : null,
                                      has(e.acVoltage) && has(e.acAmpere) && e.chargingType !== 'DC' ? e.acVoltage + ' V / ' + e.acAmpere + ' A' : null]) : null;
      box.appendChild(this.extRow(info.charging ? "fa-bolt" : "fa-plug", left, right, sub, info.charging ? "#5cbc82" : null));
    }

    // last charging session
    if (c.showLastCharge && e.lastCharge) {
      var lc = e.lastCharge;
      box.appendChild(this.extRow("fa-history",
        this.fmtTime(lc.endTime) || 'Last charge',
        has(lc.startSoc) && has(lc.endSoc) ? lc.startSoc + '\u2192' + lc.endSoc + ' %' : null,
        joinNb([has(lc.energyKwh) ? '+' + lc.energyKwh + ' kWh' : null, this.fmtDuration(lc.durationMin), has(lc.avgKw) ? '\u2300 ' + lc.avgKw + ' kW' : null, lc.location])));
    }

    // last trip
    if (c.showTrip && e.trip && (e.trip.endTime || has(e.trip.endSoc))) {
      var tr = e.trip, dist = tr.distance;
      if (has(dist) && c.useUSUnits) dist = Math.round(dist / 1.60934);
      var stars = (has(tr.accelStars) || has(tr.brakeStars)) ? '\u2605 ' + [tr.accelStars, tr.brakeStars].filter(has).join('/') : null;
      box.appendChild(this.extRow("fa-route",
        join([this.fmtTime(tr.endTime), has(dist) ? dist + (c.useUSUnits ? ' mi' : ' km') : null]) || 'Last trip',
        has(tr.endSoc) ? '\u2192' + tr.endSoc + ' %' : null,
        joinNb([has(tr.recuperation) ? 'recup. ' + tr.recuperation + ' kWh/100km' : null, has(tr.ecoPro) ? 'Eco ' + tr.ecoPro + ' %' : null, stars])));
    }

    // tyres: 2x2 grid laid out like the car (front on top)
    if (c.showTyres && e.tyres) {
      var diag = e.tyreDiagnosis && e.tyreDiagnosis.wheels ? e.tyreDiagnosis.wheels : {};
      var anyTyre = Object.keys(e.tyres).some(function (w) { return has(e.tyres[w].pressure) || diag[w]; });
      if (anyTyre) {
        var grid = document.createElement("div");
        grid.classList.add("bmw-tyres");
        var label = document.createElement("div");
        label.classList.add("bmw-tyres-icon");
        label.appendChild(this.faIconFactory("fa-dot-circle"));
        grid.appendChild(label);
        var cells = document.createElement("div");
        cells.classList.add("bmw-tyres-grid");
        var wearColors = {GREEN: '#5cbc82', YELLOW: 'orange', RED: 'red', GREY: '#777'};
        ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'].forEach(function (w) {
          var ty = e.tyres[w] || {}, d = diag[w] || {};
          var cell = document.createElement("span");
          cell.classList.add("bmw-tyre");
          if (d.wearColor || d.defectColor) {
            var col = (d.defectColor && d.defectColor !== 'GREEN' && d.defectColor !== 'GREY') ? d.defectColor : d.wearColor;
            var dot = self.faIconFactory("fa-circle", wearColors[col] || '#777');
            dot.classList.add("bmw-tyre-dot");
            if (has(d.dueMileage)) dot.title = d.dueMileage + ' km';
            cell.appendChild(dot);
          }
          var txt = '-';
          if (has(ty.pressure)) {
            txt = c.tyrePressureUnit === 'psi' ? Math.round(ty.pressure * 14.5038) + ' psi' : ty.pressure.toFixed(1) + ' bar';
            if (has(ty.target)) {
              var delta = ty.target - ty.pressure;
              if (delta >= c.tyreCriticalDelta) cell.style.color = 'red';
              else if (delta >= c.tyreWarningDelta) cell.style.color = 'orange';
            }
          }
          cell.appendChild(document.createTextNode(txt));
          if (has(ty.temperature)) {
            var tmp = document.createElement("span");
            tmp.classList.add("dimmed", "bmw-tyre-temp");
            tmp.appendChild(document.createTextNode(' ' + ty.temperature + '\u00b0'));
            cell.appendChild(tmp);
          }
          cells.appendChild(cell);
        });
        grid.appendChild(cells);
        box.appendChild(grid);
        var tgt = e.tyres.frontLeft && e.tyres.frontLeft.target, tgtR = e.tyres.rearLeft && e.tyres.rearLeft.target;
        if (has(tgt) || has(tgtR)) {
          var ts = document.createElement("div");
          ts.classList.add("bmw-ext-sub", "dimmed", "bmw-tyres-target");
          var fmt = function (b) { return c.tyrePressureUnit === 'psi' ? Math.round(b * 14.5038) : b.toFixed(1); };
          ts.appendChild(document.createTextNode('target ' + join([has(tgt) ? fmt(tgt) : null, has(tgtR) && tgtR !== tgt ? fmt(tgtR) : null]).replace(' \u00b7 ', ' / ') + ' ' + c.tyrePressureUnit));
          box.appendChild(ts);
        }
      }
    }
    return box;
  }
});
