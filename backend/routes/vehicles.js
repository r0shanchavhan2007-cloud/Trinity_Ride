const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/vehicles — register (or replace) the logged-in student's vehicle.
// One vehicle per student for this prototype — registering again replaces it.
router.post('/', requireAuth, async (req, res) => {
  try {
    const { vehicle_type, registration_number, model, seats_available } = req.body;
    if (!vehicle_type || !registration_number) {
      return res.status(400).json({ error: 'Vehicle type and registration number are required.' });
    }
    const type = String(vehicle_type).toLowerCase();
    if (!['bike', 'auto', 'car'].includes(type)) {
      return res.status(400).json({ error: 'Vehicle type must be bike, auto or car.' });
    }

    const [existing] = await pool.query('SELECT id FROM vehicles WHERE user_id = ?', [req.user.id]);
    if (existing.length) {
      await pool.query(
        'UPDATE vehicles SET vehicle_type=?, registration_number=?, model=?, seats_available=? WHERE user_id=?',
        [type, registration_number, model || null, seats_available || 1, req.user.id]
      );
      return res.json({ message: 'Vehicle updated.' });
    }
    const [result] = await pool.query(
      'INSERT INTO vehicles (user_id, vehicle_type, registration_number, model, seats_available) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, type, registration_number, model || null, seats_available || 1]
    );
    res.status(201).json({ vehicleId: result.insertId, message: 'Vehicle registered.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not register vehicle.' });
  }
});

// GET /api/vehicles/mine — the logged-in student's own vehicle, if any.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const [[vehicle]] = await pool.query('SELECT * FROM vehicles WHERE user_id = ?', [req.user.id]);
    res.json({ vehicle: vehicle || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch vehicle.' });
  }
});

module.exports = router;
