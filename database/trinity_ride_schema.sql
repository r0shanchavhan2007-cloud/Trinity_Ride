-- Trinity Ride — MySQL schema
-- Campus-only rideshare for Trinity Academy College of Engineering, Pune

CREATE DATABASE IF NOT EXISTS trinity_ride CHARACTER SET utf8mb4;
USE trinity_ride;

-- Students (riders and/or drivers — same table, role decided per-ride)
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  college_email VARCHAR(150) NOT NULL UNIQUE,
  id_card_number VARCHAR(40) NOT NULL UNIQUE,
  phone VARCHAR(15),
  branch VARCHAR(60),
  year_of_study VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Vehicles registered by students who want to drive
CREATE TABLE vehicles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  vehicle_type ENUM('bike','auto','car') NOT NULL,
  registration_number VARCHAR(20) NOT NULL,
  model VARCHAR(60),
  seats_available TINYINT DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Rotating scan codes tied to a student's identity (short-lived, not static)
CREATE TABLE qr_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  code_token VARCHAR(120) NOT NULL UNIQUE,
  issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- A ride request from a rider, before it's matched
CREATE TABLE ride_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rider_id INT NOT NULL,
  pickup_lat DECIMAL(9,6) NOT NULL,
  pickup_lng DECIMAL(9,6) NOT NULL,
  drop_lat DECIMAL(9,6) NOT NULL,
  drop_lng DECIMAL(9,6) NOT NULL,
  drop_label VARCHAR(150),
  estimated_fare DECIMAL(6,2),
  status ENUM('pending','matched','cancelled') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE CASCADE
);

-- A confirmed, in-progress or completed ride
CREATE TABLE rides (
  id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  rider_id INT NOT NULL,
  driver_id INT NOT NULL,
  vehicle_id INT,
  distance_km DECIMAL(5,2),
  fare DECIMAL(6,2),
  market_rate_reference DECIMAL(6,2),
  status ENUM('confirmed','ongoing','completed','cancelled') DEFAULT 'confirmed',
  cancelled_by INT NULL,
  cancel_reason VARCHAR(200) NULL,
  scan_started_at TIMESTAMP NULL,
  scan_ended_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES ride_requests(id),
  FOREIGN KEY (rider_id) REFERENCES users(id),
  FOREIGN KEY (driver_id) REFERENCES users(id),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
  FOREIGN KEY (cancelled_by) REFERENCES users(id)
);

-- Ratings after a completed ride
CREATE TABLE ratings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ride_id INT NOT NULL,
  rated_by INT NOT NULL,
  rated_user INT NOT NULL,
  stars TINYINT CHECK (stars BETWEEN 1 AND 5),
  comment VARCHAR(300),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE,
  FOREIGN KEY (rated_by) REFERENCES users(id),
  FOREIGN KEY (rated_user) REFERENCES users(id)
);

-- Live location pings while a ride is ongoing (for the map tracking view)
CREATE TABLE location_pings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ride_id INT NOT NULL,
  lat DECIMAL(9,6) NOT NULL,
  lng DECIMAL(9,6) NOT NULL,
  pinged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE
);

CREATE INDEX idx_qr_token ON qr_codes(code_token);
CREATE INDEX idx_rides_status ON rides(status);
CREATE INDEX idx_pings_ride ON location_pings(ride_id, pinged_at);

-- ── Ride-status views ──────────────────────────────────────────────
-- Each joins in rider/driver names so the app (or you, in a MySQL client)
-- can read a ride's state without writing the joins every time.

-- Rides that are confirmed (driver assigned, not yet scanned) or ongoing
-- (scanned and in progress). This is what a "my current ride" screen queries.
CREATE VIEW v_current_rides AS
SELECT
  r.id AS ride_id, r.status, r.distance_km, r.fare, r.scan_started_at,
  rider.id AS rider_id, rider.full_name AS rider_name,
  driver.id AS driver_id, driver.full_name AS driver_name,
  req.drop_label, r.created_at
FROM rides r
JOIN users rider  ON rider.id  = r.rider_id
JOIN users driver ON driver.id = r.driver_id
JOIN ride_requests req ON req.id = r.request_id
WHERE r.status IN ('confirmed', 'ongoing');

-- Completed rides, with the rating given to the driver if one exists yet.
CREATE VIEW v_completed_rides AS
SELECT
  r.id AS ride_id, r.distance_km, r.fare, r.market_rate_reference,
  rider.id AS rider_id, rider.full_name AS rider_name,
  driver.id AS driver_id, driver.full_name AS driver_name,
  req.drop_label, r.scan_started_at, r.scan_ended_at,
  rt.stars AS driver_rating
FROM rides r
JOIN users rider  ON rider.id  = r.rider_id
JOIN users driver ON driver.id = r.driver_id
JOIN ride_requests req ON req.id = r.request_id
LEFT JOIN ratings rt ON rt.ride_id = r.id AND rt.rated_user = r.driver_id
WHERE r.status = 'completed';

-- Cancelled rides, with who cancelled and why.
CREATE VIEW v_cancelled_rides AS
SELECT
  r.id AS ride_id, r.fare,
  rider.id AS rider_id, rider.full_name AS rider_name,
  driver.id AS driver_id, driver.full_name AS driver_name,
  r.cancelled_by, canceller.full_name AS cancelled_by_name,
  r.cancel_reason, r.created_at
FROM rides r
JOIN users rider  ON rider.id  = r.rider_id
JOIN users driver ON driver.id = r.driver_id
LEFT JOIN users canceller ON canceller.id = r.cancelled_by
WHERE r.status = 'cancelled';

-- Example lookups:
--   SELECT * FROM v_current_rides   WHERE rider_id = 12 OR driver_id = 12;
--   SELECT * FROM v_completed_rides WHERE rider_id = 12 ORDER BY scan_ended_at DESC;
--   SELECT * FROM v_cancelled_rides WHERE rider_id = 12 ORDER BY created_at DESC;

