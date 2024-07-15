"use strict";

/* global grist, window */

let amap;
let popups = {};
let selectedTableId = null;
let selectedRowId = null;
let selectedRecords = null;
let mode = 'multi';
//let mapSource = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
let mapSource = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
let mapCopyright = '<a href="https://www.openstreetmap.org">Openstreetmap</a>';
// Required, Label value
const NameDepart = "NameDepart";
const NameArrivee = "NameArrivee";
// Required
const LongitudeDepart = "LongitudeDepart";
const LongitudeArrivee = "LongitudeArrivee";
// Required
const LatitudeDepart = "LatitudeDepart";
const LatitudeArrivee = "LatitudeArrivee";
// Optional - switch column to trigger geocoding
const GeocodeDepart = 'GeocodeDepart';
const GeocodeArrivee = 'GeocodeArrivee';
// Optional - but required for geocoding. Field with address to find (might be formula)
const AddressDepart = 'AddressDepart';
const AddressArrivee = 'AddressArrivee';
// Optional - but useful for geocoding. Blank field which map uses
//            to store last geocoded Address. Enables map widget
//            to automatically update the geocoding if Address is changed
const GeocodedAddressDepart = 'GeocodedAddressDepart';
const GeocodedAddressArrivee = 'GeocodedAddressArrivee';
let lastRecord;
let lastRecords;


//Color markers downloaded from leaflet repo, color-shifted to green
//Used to show currently selected pin
const selectedIcon =  new L.Icon({
  iconUrl: 'marker-icon-green.png',
  iconRetinaUrl: 'marker-icon-green-2x.png',
  shadowUrl: 'marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});
const defaultIcon =  new L.Icon.Default();



// Creates clusterIcons that highlight if they contain selected row
// Given a function `() => selectedMarker`, return a cluster icon create function
// that can be passed to MarkerClusterGroup({iconCreateFunction: ... } )
//
// Cluster with selected record gets the '.marker-cluster-selected' class
// (defined in screen.css)
//
// Copied from _defaultIconCreateFunction in ClusterMarkerGroup
//    https://github.com/Leaflet/Leaflet.markercluster/blob/master/src/MarkerClusterGroup.js
const selectedRowClusterIconFactory = function (selectedMarkerGetter) {
  return function(cluster) {
    var childCount = cluster.getChildCount();

    let isSelected = false;
    try {
      const selectedMarker = selectedMarkerGetter();

      // hmm I think this is n log(n) to build all the clusters for the whole map.
      // It's probably fine though, it only fires once when map markers
      // are set up or when selectedRow changes
      isSelected = cluster.getAllChildMarkers().filter((m) => m == selectedMarker).length > 0;
    } catch (e) {
      console.error("WARNING: Error in clusterIconFactory in map widget");
      console.error(e);
    }

    var c = ' marker-cluster-';
    if (childCount < 10) {
      c += 'small';
    } else if (childCount < 100) {
      c += 'medium';
    } else {
      c += 'large';
    }

    return new L.DivIcon({
        html: '<div><span>'
            + childCount
            + ' <span aria-label="markers"></span>'
            + '</span></div>',
        className: 'marker-cluster' + c + (isSelected ? ' marker-cluster-selected' : ''),
        iconSize: new L.Point(40, 40)
    });
  }
};

const geocoder = L.Control.Geocoder && L.Control.Geocoder.nominatim();
if (URLSearchParams && location.search && geocoder) {
  const c = new URLSearchParams(location.search).get('geocoder');
  if (c && L.Control.Geocoder[c]) {
    console.log('Using geocoder', c);
    geocoder = L.Control.Geocoder[c]();
  } else if (c) {
    console.warn('Unsupported geocoder', c);
  }
  const m = new URLSearchParams(location.search).get('mode');
  if (m) { mode = m; }
}

async function geocode(address) {
  console.log('geocode');
  return new Promise((resolve, reject) => {
    try {
      geocoder.geocode(address, (v) => {
        v = v[0];
        if (v) { v = v.center; }
        resolve(v);
      });
    } catch (e) {
      console.log("Problem:", e);
      reject(e);
    }
  });
}

async function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// If widget has wright access
let writeAccess = true;
// A ongoing scanning promise, to check if we are in progress.
let scanning = null;

async function scan(tableId, records, mappings) {
  console.log('scan');
  if (!writeAccess) { return; }
  for (const record of records) {
    // console.log(record);
    // We can only scan if Geocode column was mapped.
    //if (!(GeocodeDepart in record)) { break; }
    // And the value in the column is truthy.
    //if (!record[GeocodeDepart]) { continue; }
    // Get the address to search.
    const addressDepart = record.AddressDepart;
    // Little caching here. We will set GeocodedAddress to last address we searched,
    // so after next round - we will check if the address is indeed changed.
    // But this field is optional, if it is not in the record (not mapped)
    // we will find the location each time (if coordinates are empty).
    if (record[GeocodedAddressDepart] && record[GeocodedAddressDepart] !== record.AddressDepart) {
      // We have caching field, and last address is diffrent.
      // So clear coordinates (as if the record wasn't scanned before)
      record[LongitudeDepart] = null;
      record[LatitudeDepart] = null;
    }
    // If address is not empty, and coordinates are empty (or were cleared by cache)
    if (addressDepart && !record[LongitudeDepart]) {
      // Find coordinates.
      const result = await geocode(addressDepart);

      // Update them, and update cache (if the field was mapped)
      await grist.docApi.applyUserActions([ ['UpdateRecord', tableId, record.id, {
        [mappings[LongitudeDepart]]: result.lng,
        [mappings[LatitudeDepart]]: result.lat,
        ...(GeocodedAddressDepart in mappings) ? {[mappings[GeocodedAddressDepart]]: addressDepart} : undefined
      }] ]);
      await delay(1000);
    }

    // même chose pour l'arrivée
    const addressArrivee = record.AddressArrivee;
    if (record[GeocodedAddressArrivee] && record[GeocodedAddressArrivee] !== record.AddressArrivee) {
      // We have caching field, and last address is diffrent.
      // So clear coordinates (as if the record wasn't scanned before)
      record[LongitudeArrivee] = null;
      record[LatitudeArrivee] = null;
    }
    // If address is not empty, and coordinates are empty (or were cleared by cache)
    if (addressArrivee && !record[LongitudeArrivee]) {
      // Find coordinates.
      const result2 = await geocode(addressArrivee);

      // Update them, and update cache (if the field was mapped)
      await grist.docApi.applyUserActions([ ['UpdateRecord', tableId, record.id, {
        [mappings[LongitudeArrivee]]: result2.lng,
        [mappings[LatitudeArrivee]]: result2.lat,
        ...(GeocodedAddressArrivee in mappings) ? {[mappings[GeocodedAddressArrivee]]: addressArrivee} : undefined
      }] ]);
      await delay(1000);
    }

    // on calcule les distances / durées
    if (record[LongitudeDepart] && record[LatitudeDepart] && record[LongitudeArrivee] && record[LatitudeArrivee]) {
      console.log(record[LatitudeDepart] ,record[LongitudeDepart] , record[LatitudeArrivee],  record[LongitudeArrivee] )
      const routeInfo = await getRouteInfo(LatitudeDepart, LongitudeDepart, LatitudeArrivee, LongitudeArrivee);
      console.log(routeInfo);
    }
  }
}

function scanOnNeed(mappings) {
  if (!scanning && selectedTableId && selectedRecords) {
    scanning = scan(selectedTableId, selectedRecords, mappings).then(() => scanning = null).catch(() => scanning = null);
  }
}

function showProblem(txt) {
  document.getElementById('map').innerHTML = '<div class="error">' + txt + '</div>';
}

// Little extra wrinkle to deal with showing differences.  Should be taken
// care of by Grist once diffing is out of beta.
function parseValue(v) {
  if (typeof(v) === 'object' && v !== null && v.value && v.value.startsWith('V(')) {
    const payload = JSON.parse(v.value.slice(2, v.value.length - 1));
    return payload.remote || payload.local || payload.parent || payload;
  }
  return v;
}

function getInfo(rec) {
  const result = {
    id: rec.id,
    name: parseValue(rec[NameDepart]),
    lng: parseValue(rec[LongitudeDepart]),
    lat: parseValue(rec[LatitudeDepart])
  };
  return result;
}

// Function to clear last added markers. Used to clear the map when new record is selected.
let clearMakers = () => {};

let markers = [];

function updateMap(data) {
  data = data || selectedRecords;
  selectedRecords = data;
  if (!data || data.length === 0) {
    showProblem("No data found yet");
    return;
  }
  if (!(LongitudeDepart in data[0] && LatitudeDepart in data[0] && NameDepart in data[0])) {
    showProblem("Table does not yet have all expected columns: Name, Longitude, Latitude. You can map custom columns"+
    " in the Creator Panel.");
    return;
  }


  // Map tile source:
  //    https://leaflet-extras.github.io/leaflet-providers/preview/
  //    Old source was natgeo world map, but that only has data up to zoom 16
  //    (can't zoom in tighter than about 10 city blocks across)
  //
  const tiles = L.tileLayer(mapSource, { attribution: mapCopyright });

  const error = document.querySelector('.error');
  if (error) { error.remove(); }
  if (amap) {
    try {
      amap.off();
      amap.remove();
    } catch (e) {
      // ignore
      console.warn(e);
    }
  }
  const map = L.map('map', {
    layers: [tiles],
    wheelPxPerZoomLevel: 90, //px, default 60, slows scrollwheel zoom
  });

  // ajout du "controlleur" pour la routing machine de Leaflet
  var routeControl = L.Routing.control({
  //   waypoints: [
  //   L.latLng(57.74, 11.94),
  //   L.latLng(57.6792, 11.949)
  // ],
    // router: L.Routing.mapbox('pk.eyJ1IjoiZ3VpeDY5IiwiYSI6ImNseWZ3b2FsYzAzdXIyanNkZW00bXhweGkifQ.Ied47cTbU0Sci8bOSdsikw')
  }).addTo(map);

  routeControl.on('routesfound', function(e) {
      var routes = e.routes;
      var summary = routes[0].summary;
      // alert distance and time in km and minutes
      console.log('Totall distance is ' + summary.totalDistance / 1000 + ' km and total time is ' + Math.round(summary.totalTime % 3600 / 60) + ' minutes');
    });

async function getRouteInfo(LatitudeDepart, LongitudeDepart, LatitudeArrivee, LongitudeArrivee) {
  console.log('getRouteInfo');
  return new Promise((resolve, reject) => {
    try {
      routeControl.setWaypoints=[
        L.latLng(LatitudeDepart, LongitudeDepart),
        L.latLng(LatitudeArrivee, LongitudeArrivee)
      ];

    routeControl.on('routesfound', function(e) {
      var routes = e.routes;
      var summary = routes[0].summary;
      // alert distance and time in km and minutes
      console.log('Total distance is ' + summary.totalDistance / 1000 + ' km and total time is ' + Math.round(summary.totalTime % 3600 / 60) + ' minutes');
      resolve(summary);
    });
    } catch (e) {
      console.log("Problem:", e);
      reject(e);
    }
  });
}

  // Make sure clusters always show up above points
  // Default z-index for markers is 600, 650 is where tooltipPane z-index starts
  map.createPane('selectedMarker').style.zIndex = 620;
  map.createPane('clusters'      ).style.zIndex = 610;
  map.createPane('otherMarkers'  ).style.zIndex = 600;

  const points = []; //L.LatLng[], used for zooming to bounds of all markers

  popups = {}; // Map: {[rowid]: L.marker}
  // Make this before markerClusterGroup so iconCreateFunction
  // can fetch the currently selected marker from popups by function closure

  markers = L.markerClusterGroup({
    disableClusteringAtZoom: 18,
    //If markers are very close together, they'd stay clustered even at max zoom
    //This disables that behavior explicitly for max zoom (18)
    maxClusterRadius: 30, //px, default 80
    // default behavior clusters too aggressively. It's nice to see individual markers
    showCoverageOnHover: true,

    clusterPane: 'clusters', //lets us specify z-index, so cluster icons can be on top
    iconCreateFunction: selectedRowClusterIconFactory(() => popups[selectedRowId]),
  });

  markers.on('click', (e) => {
    const id = e.layer.options.id;
    selectMaker(id);
  });

  for (const rec of data) {
    const {id, name, lng, lat} = getInfo(rec);
    // If the record is in the middle of geocoding, skip it.
    if (String(lng) === '...') { continue; }
    if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) {
      // Stuff at 0,0 usually indicates bad imports/geocoding.
      continue;
    }
    const pt = new L.LatLng(lat, lng);
    points.push(pt);

    const marker = L.marker(pt, {
      title: name,
      id: id,
      icon: (id == selectedRowId) ?  selectedIcon    :  defaultIcon,
      pane: (id == selectedRowId) ? "selectedMarker" : "otherMarkers",
    });

    marker.bindPopup(name);
    markers.addLayer(marker);

    popups[id] = marker;
  }
  map.addLayer(markers);

  clearMakers = () => map.removeLayer(markers);

  try {
    map.fitBounds(new L.LatLngBounds(points), {maxZoom: 15, padding: [0, 0]});
  } catch (err) {
    console.warn('cannot fit bounds');
  }
  function makeSureSelectedMarkerIsShown() {
    const rowId = selectedRowId;

    if (rowId && popups[rowId]) {
      var marker = popups[rowId];
      if (!marker._icon) { markers.zoomToShowLayer(marker); }
      marker.openPopup();
    }
  }

  amap = map;

  makeSureSelectedMarkerIsShown();
}

function selectMaker(id) {
   // Reset the options from the previously selected marker.
   const previouslyClicked = popups[selectedRowId];
   if (previouslyClicked) {
     previouslyClicked.setIcon(defaultIcon);
     previouslyClicked.pane = 'otherMarkers';
   }
   const marker = popups[id];
   if (!marker) { return null; }

   // Remember the new selected marker.
   selectedRowId = id;

   // Set the options for the newly selected marker.
   marker.setIcon(selectedIcon);
   previouslyClicked.pane = 'selectedMarker';

   // Rerender markers in this cluster
   markers.refreshClusters();

   // Update the selected row in Grist.
   grist.setCursorPos?.({rowId: id}).catch(() => {});

   return marker;
}


grist.on('message', (e) => {
  if (e.tableId) { selectedTableId = e.tableId; }
});

function hasCol(col, anything) {
  return anything && typeof anything === 'object' && col in anything;
}

function defaultMapping(record, mappings) {
  if (!mappings) {
    return {
      [LongitudeDepart]: LongitudeDepart,
      [NameDepart]: NameDepart,
      [LatitudeDepart]: LatitudeDepart,
      [AddressDepart]: hasCol(AddressDepart, record) ? AddressDepart : null,
      [GeocodedAddressDepart]: hasCol(GeocodedAddressDepart, record) ? GeocodedAddressDepart : null,
      [GeocodeDepart]: hasCol(GeocodeDepart, record) ? GeocodeDepart : null,
    };
  }
  return mappings;
}

function selectOnMap(rec) {
  // If this is already selected row, do nothing (to avoid flickering)
  if (selectedRowId === rec.id) { return; }

  selectedRowId = rec.id;
  if (mode === 'single') {
    updateMap([rec]);
  } else {
    updateMap();
  }
}

grist.onRecord((record, mappings) => {
  if (mode === 'single') {
    // If mappings are not done, we will assume that table has correct columns.
    // This is done to support existing widgets which where configured by
    // renaming column names.
    lastRecord = grist.mapColumnNames(record) || record;
    selectOnMap(lastRecord);
    scanOnNeed(defaultMapping(record, mappings));
  } else {
    const marker = selectMaker(record.id);
    if (!marker) { return; }
    markers.zoomToShowLayer(marker);
    marker.openPopup();
  }
});
grist.onRecords((data, mappings) => {
  lastRecords = grist.mapColumnNames(data) || data;
  if (mode !== 'single') {
    // If mappings are not done, we will assume that table has correct columns.
    // This is done to support existing widgets which where configured by
    // renaming column names.
    updateMap(lastRecords);
    if (lastRecord) {
      selectOnMap(lastRecord);
    }
    // We need to mimic the mappings for old widgets
    scanOnNeed(defaultMapping(data[0], mappings));
  }
});

grist.onNewRecord(() => {
  clearMakers();
  clearMakers = () => {};
})

function updateMode() {
  if (mode === 'single') {
    selectedRowId = lastRecord.id;
    updateMap([lastRecord]);
  } else {
    updateMap(lastRecords);
  }
}

function onEditOptions() {
  const popup = document.getElementById("settings");
  popup.style.display = 'block';
  const btnClose = document.getElementById("btnClose");
  btnClose.onclick = () => popup.style.display = 'none';
  const checkbox = document.getElementById('cbxMode');
  checkbox.checked = mode === 'multi' ? true : false;
  checkbox.onchange = async (e) => {
    const newMode = e.target.checked ? 'multi' : 'single';
    if (newMode != mode) {
      mode = newMode;
      await grist.setOption('mode', mode);
      updateMode();
    }
  }
  [ "mapSource", "mapCopyright" ].forEach((opt) => {
    const ipt = document.getElementById(opt)
    ipt.onchange = async (e) => {
      await grist.setOption(opt, e.target.value);
    }
  })
}

const optional = true;
grist.ready({
  columns: [
    { name: "NameDepart", title: 'Libellé départ', type: 'Text'},
    { name: "LongitudeDepart", title: 'Longitude départ', type: 'Numeric'} ,
    { name: "LatitudeDepart", title: 'Latitude départ', type: 'Numeric'},
    { name: "GeocodeDepart", type: 'Bool', title: 'Geocode départ', optional},
    { name: "AddressDepart", title: 'Adresse départ', type: 'Text', optional, optional},
    { name: "GeocodedAddressDepart", type: 'Text', title: 'Geocoded Address départ', optional},
    { name: "NameArrivee", title: 'Libellé arrivée', type: 'Text'},
    { name: "LongitudeArrivee", title: 'Longitude arrivée', type: 'Numeric'} ,
    { name: "LatitudeArrivee", title: 'Latitude arrivée', type: 'Numeric'},
    { name: "GeocodeArrivee", type: 'Bool', title: 'Geocode arrivée', optional},
    { name: "AddressArrivee", title: 'Adresse arrivée', type: 'Text', optional, optional},
    { name: "GeocodedAddressArrivee", type: 'Text', title: 'Geocoded Address arrivée', optional},
  ],
  allowSelectBy: true,
  onEditOptions
});

grist.onOptions((options, interaction) => {
  writeAccess = interaction.accessLevel === 'full';
  const newMode = options?.mode ?? mode;
  mode = newMode;
  if (newMode != mode && lastRecords) {
    updateMode();
  }
  const newSource = options?.mapSource ?? mapSource;
  mapSource = newSource;
  document.getElementById("mapSource").value = mapSource;
  const newCopyright = options?.mapCopyright ?? mapCopyright;
  mapCopyright = newCopyright
  document.getElementById("mapCopyright").value = mapCopyright;
});
