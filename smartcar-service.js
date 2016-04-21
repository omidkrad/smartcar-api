"use strict";

const config = {
    port: 3000,
    requireHTTPS: false, // TODO: enable SSL when hosting
    apiVersion: "1.0"
};

const app = require('express')();
const request = require('request-promise');
const _ = require('lodash');
const low = require('lowdb');
const storage = require('lowdb/file-async');
const db = low('db.json', { storage });
const bodyParser = require('body-parser');

// middleware to support JSON-encoded bodies
app.use(bodyParser.json());

// middleware to redirect to https
function requireHTTPS(req, res, next) {
    if (!req.secure && req.get('x-forwarded-proto') !== 'https'
        && process.env.NODE_ENV !== "development") {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
};

if (config.requireHTTPS) {
    app.use(requireHTTPS)
};

// smartcar vehicle API
const baseUrl ='/api/v' + config.apiVersion;
const vehiclesEndPoint = baseUrl + '/vehicles';
const vehicleEndPoint = vehiclesEndPoint + '/:id';
const securityEndPoint = vehicleEndPoint + '/doors';
const fuelEndPoint = vehicleEndPoint + '/fuel';
const batteryEndPoint = vehicleEndPoint + '/battery';
const engineEndPoint = vehicleEndPoint + '/engine';

// manufacturer vehicle API
const gmBaseUrl = 'http://gmapi.azurewebsites.net';
const gmVehicleUrl = gmBaseUrl + '/getVehicleInfoService';
const gmSecurityUrl = gmBaseUrl + '/getSecurityStatusService';
const gmEnergyUrl = gmBaseUrl + '/getEnergyService';
const gmEngineUrl = gmBaseUrl + '/actionEngineService';

app.get('/version', (req, res) => {
    res.set('content-type', 'text/plain')
    .send(config.apiVersion);
});

// api entry endpint
app.get(['/', '/api', baseUrl], (req, res) => {
    res.send({
        name: "smartcar-api",
        version: config.apiVersion,
        links: {
            vehicles: vehiclesEndPoint
        }
    });
});

// adds a discovery URL to a resource object
Object.prototype.makeDiscoverable = function(endPoint, idField) {
    return Object.assign(this,
        { links: { url: endPoint + '/' + this[idField] } }
    );
}

// ------------ VEHICLES ------------

function createVehicleViewModel(vehicle) {
    if (!vehicle) return { id: "unknown" };
    // clone so db record is not modified
    vehicle = _.clone(vehicle);
    // add url
    vehicle.makeDiscoverable(vehiclesEndPoint, 'id');
    var discoveryUrl = vehicle.links.url;
    vehicle.links = {
        url: discoveryUrl,
        security: discoveryUrl + '/doors',
        fuel: discoveryUrl + '/fuel',
        battery: discoveryUrl + '/battery',
        engine: discoveryUrl + '/engine',
    }
    return vehicle;
}

// Get all vehicles (cached only)
app.get(vehiclesEndPoint, (req, res) => {
    var vehicles = db('vehicles')
    .map(createVehicleViewModel);
    res.send(vehicles);
});

/**
 * Makes an async request to the manufacturer's Url and returns a Promise.
 * typescript definition:
 *       requestResource(options: { id: string, uri: string, command?: string })
 */
function requestResource(options) {
    return request({
        method: 'POST',
        uri: options.uri,
        headers: {
            'Content-Type': 'application/json'
        },
        body: {
            id: options.id,
            responseType: "JSON",
            command: options.command || ''
        },
        json: true // parses the JSON string in the response
    });
}

/**
 * Retrieves a vehicle with the specified id. This function will try to use the cached data
 * first and if not available then will make a request to the backend API and cache data
 * for subsequent requests.
 */
function getVehicle(id) {
    return new Promise((resolve, reject) => {
        var dbVehicle = db('vehicles').find({ id });

        // if not cached then query the manufacturer's API
        if (dbVehicle == null) {
            console.log('--- Requesting: ' + gmVehicleUrl);
            requestResource({
                id, uri: gmVehicleUrl
            })
            .then(response => {
                if (response.status == 200) {
                    var vehicle = response.data;
                    var transform = {
                        id,
                        vin: vehicle.vin.value || 'unknown',
                        color: vehicle.color.value || 'unknown',
                        doorCount: vehicle.twoDoorCoupe.value.toLowerCase() === "true" ? 2
                                 : vehicle.fourDoorSedan.value.toLowerCase() === "true" ? 4 : 'unknown',
                        driveTrain: vehicle.driveTrain.value || 'unknown'
                    };
                    if (verifyIntegrity(transform)) {
                        // persist in db
                        db('vehicles').push(transform);
                    }
                    // success response
                    resolve(transform);
                }
                else {
                    console.error("--- Error: " + response.reason);
                    reject(response);
                }
            })
            .catch(err => {
                // API call failed
                console.error(err);
                reject(err);
            });
        }
        else {
            console.log('--- Retrieved vehicle info from cache.');
            // pass the vehicle we got from database
            resolve(dbVehicle);
        }
    });
}

// Get vehicle
app.get(vehicleEndPoint, (req, res) => {
    var id = req.params.id;
    getVehicle(id).then(vehicle =>
        res.send(createVehicleViewModel(vehicle))
    )
    .catch(err => {
        res.status(err.status)
        .send(err.reason || err);
    });
});

// Get security
app.get(securityEndPoint, (req, res) => {
    var id = req.params.id;
    requestResource({
        id, uri: gmSecurityUrl
    })
    .then(response => {
        if (response.status == 200) {
            try {
                var doors = response.data.doors.values;
                var transform = [];
                for (var door of doors) {
                    transform.push({
                        location: door.location.value || 'unknown',
                        locked: door.locked.value.toLowerCase() == "true" ? true
                              : door.locked.value.toLowerCase() == "false" ? false : 'unknown'
                    });
                }
                // detect and log data integrity issues
                verifyIntegrity(transform);
                // success response
                res.send(transform);
            }
            catch (err) {
                res.status(500)
                .send(err);
            }
        }
        else {
            res.status(response.status || 500)
            .send(response.reason || err);
        }
    })
    .catch(err => {
        res.status(err.status || 500)
        .send(err.reason || err);
    });
});

// Get fuel range
app.get(fuelEndPoint, (req, res) => {
    var id = req.params.id;
    requestResource({
        id, uri: gmEnergyUrl
    })
    .then(response => {
        if (response.status == 200) {
            try {
                var fuelLevel = Number(response.data.tankLevel.value) || 'unknown';
                var transform = {
                    percent: fuelLevel
                }
                // detect and log data integrity issues
                verifyIntegrity(transform);
                // success response
                res.send(transform);
            }
            catch (err) {
                res.status(500)
                .send(err);
            }
        }
        else {
            res.status(response.status || 500)
            .send(response.reason || err);
        }
    })
    .catch(err => {
        res.status(err.status || 500)
        .send(err.reason || err);
    });
});

// Get battery range
app.get(batteryEndPoint, (req, res) => {
    var id = req.params.id;
    requestResource({
        id, uri: gmEnergyUrl
    })
    .then(response => {
        if (response.status == 200) {
            try {
                var batteryLevel = Number(response.data.batteryLevel.value) || 'unknown';
                var transform = {
                    percent: batteryLevel
                }
                // detect and log data integrity issues
                verifyIntegrity(transform);
                // success response
                res.send(transform);
            }
            catch (err) {
                res.status(500)
                .send(err);
            }
        }
        else {
            res.status(response.status || 500)
            .send(response.reason || err);
        }
    })
    .catch(err => {
        res.status(err.status || 500)
        .send(err.reason || err);
    });
});

// Start/Stop engine
app.post(engineEndPoint, (req, res) => {
    var id = req.params.id;
    var action = req.body.action;
    console.log(action);
    if (action !== 'START' && action !== 'STOP') {
        res.status(400)
        .send("invalid action");
        return;
    }
    requestResource({
        id, uri: gmEngineUrl,
        command: (action === 'START') ? 'START_VEHICLE'
                : (action === 'STOP') ? 'STOP_VEHICLE' : ''
    })
    .then(response => {
        if (response.status == 200) {
            try {
                var actionExecuted = response.actionResult.status === 'EXECUTED';
                var transform = {
                    status: (actionExecuted) ? 'success' : 'error'
                };
                res.send(transform);
            }
            catch (err) {
                res.status(500)
                .send(err);
            }
        }
        else {
            res.status(response.status || 500)
            .send(response.reason || err);
        }
    })
    .catch(err => {
        res.status(err.status || 500)
        .send(err.reason || err);
    });
});

// Checks if there are any missing data in the properties of the specified object.
function verifyIntegrity(obj) {
    for (var key in obj) {
        // look in the properties that are not inherited from prototype
        if (obj.hasOwnProperty(key)) { 
            var value = obj[key];
            console.log(value);
            if (value == null || value == undefined || value == 'unknown') {
                console.warn("--- Detected missing data! Verify if there have been changes in the integrated API.", obj);
                return false;
            }
        }
    }
    return true;
}

app.listen(config.port, () => {
    console.log(`Listening on port ${config.port}!`);
});
