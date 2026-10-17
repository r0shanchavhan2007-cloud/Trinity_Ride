const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BASE_FARE = Number(process.env.BASE_FARE || 25);
const RATE_PER_KM = Number(process.env.RATE_PER_KM || 14);
const DISCOUNT = Number(process.env.DISCOUNT_VS_MARKET || 0.10);

// Haversine distance in km between two lat/lng points.
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function computeFare(km) {
  const marketRate = BASE_FARE + RATE_PER_KM * km;
  return { fare: Math.round(marketRate * (1 - DISCOUNT)), marketRate: Math.round(marketRate) };
}

// POST /api/rides/request
// Rider submits pickup + drop coordinates. Returns a fare estimate and
// a request_id to attach a driver to once one is chosen.
router.post('/request', requireAuth, async (req, res) => {
  try {
    const { pickup_lat, pickup_lng, drop_lat, drop_lng, drop_label, fare: clientFare } = req.body;
    if ([pickup_lat, pickup_lng, drop_lat, drop_lng].some((v) => v === undefined)) {
      return res.status(400).json({ error: 'pickup_lat, pickup_lng, drop_lat and drop_lng are required.' });
    }

    const km = +distanceKm(pickup_lat, pickup_lng, drop_lat, drop_lng).toFixed(2);
    // Trust the fare the rider's app already showed them (it includes the
    // PMPML-stage pricing and vehicle-type multiplier) rather than
    // recomputing a different number here — a driver must see the exact
    // same fare the rider was quoted, never a different one.
    const { fare: serverFare, marketRate } = computeFare(km);
    const fare = typeof clientFare === 'number' && clientFare > 0 ? clientFare : serverFare;

    const [result] = await pool.query(
      `INSERT INTO ride_requests (rider_id, pickup_lat, pickup_lng, drop_lat, drop_lng, drop_label, estimated_fare, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, pickup_lat, pickup_lng, drop_lat, drop_lng, drop_label || null, fare]
    );

    res.status(201).json({ requestId: result.insertId, distanceKm: km, fare, marketRate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create ride request.' });
  }
});

// GET /api/rides/nearby-drivers?lat=..&lng=..&radiusKm=3
// Returns verified students with a registered vehicle near a point.
// TODO: once drivers send live pings, filter by their latest location_pings
// row instead of returning all registered vehicles.
router.get('/nearby-drivers', requireAuth, async (req, res) => {
  try {
    const [drivers] = await pool.query(
      `SELECT u.id, u.full_name, u.branch, v.vehicle_type, v.model, v.seats_available
       FROM vehicles v
       JOIN users u ON u.id = v.user_id
       WHERE u.is_verified = TRUE AND u.id != ?
       LIMIT 10`,
      [req.user.id]
    );
    res.json({ drivers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch nearby drivers.' });
  }
});

// POST /api/rides/confirm
// Rider picks a driver for their pending request. Creates the ride row.
router.post('/confirm', requireAuth, async (req, res) => {
  try {
    const { request_id, driver_id, vehicle_id } = req.body;
    const [[request]] = await pool.query('SELECT * FROM ride_requests WHERE id = ? AND rider_id = ?', [
      request_id,
      req.user.id,
    ]);
    if (!request) return res.status(404).json({ error: 'Ride request not found.' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request is no longer pending.' });

    const km = +distanceKm(request.pickup_lat, request.pickup_lng, request.drop_lat, request.drop_lng).toFixed(2);
    const { fare, marketRate } = computeFare(km);

    const [ride] = await pool.query(
      `INSERT INTO rides (request_id, rider_id, driver_id, vehicle_id, distance_km, fare, market_rate_reference, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
      [request_id, req.user.id, driver_id, vehicle_id || null, km, fare, marketRate]
    );
    await pool.query("UPDATE ride_requests SET status = 'matched' WHERE id = ?", [request_id]);

    res.status(201).json({ rideId: ride.insertId, fare, distanceKm: km });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not confirm ride.' });
  }
});

// POST /api/rides/:id/ping — driver's app posts location while ongoing.
router.post('/:id/ping', requireAuth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    await pool.query('INSERT INTO location_pings (ride_id, lat, lng) VALUES (?, ?, ?)', [req.params.id, lat, lng]);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record location.' });
  }
});

// POST /api/rides/:id/end — either party ends the ride once the drop is reached.
router.post('/:id/end', requireAuth, async (req, res) => {
  try {
    const [[ride]] = await pool.query('SELECT * FROM rides WHERE id = ?', [req.params.id]);
    if (!ride) return res.status(404).json({ error: 'Ride not found.' });
    if (![ride.rider_id, ride.driver_id].includes(req.user.id)) {
      return res.status(403).json({ error: 'Not a participant on this ride.' });
    }
    if (!['confirmed', 'ongoing'].includes(ride.status)) {
      return res.status(409).json({ error: `Ride is ${ride.status}, can't be ended.` });
    }

    await pool.query("UPDATE rides SET status = 'completed', scan_ended_at = NOW() WHERE id = ?", [req.params.id]);
    res.json({ message: 'Ride completed.', fare: ride.fare });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not end ride.' });
  }
});

// POST /api/rides/:id/cancel — either party cancels before the ride has started.
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    const [[ride]] = await pool.query('SELECT * FROM rides WHERE id = ?', [req.params.id]);
    if (!ride) return res.status(404).json({ error: 'Ride not found.' });
    if (![ride.rider_id, ride.driver_id].includes(req.user.id)) {
      return res.status(403).json({ error: 'Not a participant on this ride.' });
    }
    if (ride.status === 'completed' || ride.status === 'cancelled') {
      return res.status(409).json({ error: `Ride is already ${ride.status}.` });
    }
    await pool.query(
      "UPDATE rides SET status = 'cancelled', cancelled_by = ?, cancel_reason = ? WHERE id = ?",
      [req.user.id, reason || null, req.params.id]
    );
    res.json({ message: 'Ride cancelled.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not cancel ride.' });
  }
});

// GET /api/rides/pending — open ride requests a driver can accept.
// Excludes the caller's own requests, so a student can't accept their own ride.
router.get('/pending', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT rq.id AS request_id, rq.pickup_lat, rq.pickup_lng, rq.drop_lat, rq.drop_lng,
              rq.drop_label, rq.estimated_fare, rq.created_at,
              u.full_name AS rider_name, u.branch AS rider_branch, u.phone AS rider_phone
       FROM ride_requests rq
       JOIN users u ON u.id = rq.rider_id
       WHERE rq.status = 'pending' AND rq.rider_id != ?
         AND rq.created_at > NOW() - INTERVAL 30 MINUTE
       ORDER BY rq.created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch pending requests.' });
  }
});

// POST /api/rides/:requestId/accept — a driver accepts an open request.
// This is the real dispatch step: it's driver-initiated, not rider-chosen.
router.post('/:requestId/accept', requireAuth, async (req, res) => {
  try {
    const [[request]] = await pool.query(
      "SELECT * FROM ride_requests WHERE id = ? AND status = 'pending'",
      [req.params.requestId]
    );
    if (!request) return res.status(409).json({ error: 'This request is no longer available.' });
    if (request.rider_id === req.user.id) return res.status(400).json({ error: "You can't accept your own request." });

    const [[vehicle]] = await pool.query('SELECT id FROM vehicles WHERE user_id = ? LIMIT 1', [req.user.id]);
    if (!vehicle) return res.status(400).json({ error: 'Register a vehicle first (Drive & earn) before accepting rides.' });

    const km = +distanceKm(request.pickup_lat, request.pickup_lng, request.drop_lat, request.drop_lng).toFixed(2);
    const { marketRate } = computeFare(km);
    const fare = request.estimated_fare; // exactly what the rider was quoted — never a different number

    const [ride] = await pool.query(
      `INSERT INTO rides (request_id, rider_id, driver_id, vehicle_id, distance_km, fare, market_rate_reference, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
      [request.id, request.rider_id, req.user.id, vehicle.id, km, fare, marketRate]
    );
    await pool.query("UPDATE ride_requests SET status = 'matched' WHERE id = ?", [request.id]);

    const [[rider]] = await pool.query('SELECT full_name, phone, branch FROM users WHERE id = ?', [request.rider_id]);
    res.status(201).json({
      rideId: ride.insertId, fare, distanceKm: km, dropLabel: request.drop_label,
      pickupLat: request.pickup_lat, pickupLng: request.pickup_lng,
      rider: { name: rider.full_name, phone: rider.phone, branch: rider.branch },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not accept this ride.' });
  }
});

// GET /api/rides/current — rides this student is on, as rider or driver,
// that are confirmed (matched, not yet scanned) or ongoing (in progress).
router.get('/current', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM v_current_rides WHERE rider_id = ? OR driver_id = ? ORDER BY created_at DESC',
      [req.user.id, req.user.id]
    );
    res.json({ rides: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch current rides.' });
  }
});

// GET /api/rides/completed
router.get('/completed', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM v_completed_rides WHERE rider_id = ? OR driver_id = ? ORDER BY scan_ended_at DESC',
      [req.user.id, req.user.id]
    );
    res.json({ rides: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch completed rides.' });
  }
});

// GET /api/rides/cancelled
router.get('/cancelled', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM v_cancelled_rides WHERE rider_id = ? OR driver_id = ? ORDER BY created_at DESC',
      [req.user.id, req.user.id]
    );
    res.json({ rides: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch cancelled rides.' });
  }
});

module.exports = router;
