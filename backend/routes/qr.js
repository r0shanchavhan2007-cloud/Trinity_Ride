const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const TTL = Number(process.env.QR_TOKEN_TTL_SECONDS || 120);

// POST /api/qr/generate
// Issues a short-lived token for the logged-in student. The frontend
// encodes this token into a QR image — nothing sensitive is embedded
// directly, and the token expires quickly so a screenshot goes stale.
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + TTL * 1000);

    await pool.query(
      'INSERT INTO qr_codes (user_id, code_token, expires_at, used) VALUES (?, ?, ?, FALSE)',
      [req.user.id, token, expiresAt]
    );

    res.json({ token, expiresInSeconds: TTL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not generate code.' });
  }
});

// POST /api/qr/scan
// Called by the driver's device when they scan the rider's code.
// Validates the token, then starts the matching ride.
router.post('/scan', requireAuth, async (req, res) => {
  try {
    const { token, ride_id } = req.body;
    if (!token || !ride_id) {
      return res.status(400).json({ error: 'token and ride_id are required.' });
    }

    const [[qr]] = await pool.query(
      'SELECT * FROM qr_codes WHERE code_token = ? AND used = FALSE AND expires_at > NOW()',
      [token]
    );
    if (!qr) {
      return res.status(400).json({ error: 'This code is invalid or has expired. Ask the rider to refresh it.' });
    }

    const [[ride]] = await pool.query('SELECT * FROM rides WHERE id = ?', [ride_id]);
    if (!ride) return res.status(404).json({ error: 'Ride not found.' });
    if (ride.rider_id !== qr.user_id) {
      return res.status(403).json({ error: "This code doesn't match the rider on this ride." });
    }
    if (ride.driver_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the assigned driver can start this ride.' });
    }
    if (ride.status !== 'confirmed') {
      return res.status(409).json({ error: `Ride is already ${ride.status}.` });
    }

    await pool.query('UPDATE qr_codes SET used = TRUE WHERE id = ?', [qr.id]);
    await pool.query(
      "UPDATE rides SET status = 'ongoing', scan_started_at = NOW() WHERE id = ?",
      [ride_id]
    );

    res.json({ message: 'Ride started.', rideId: ride_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start ride.' });
  }
});

module.exports = router;
