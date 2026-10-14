const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const pool = require('../config/db');

const router = express.Router();

// In-memory OTP store, keyed by email. Fine for a small campus pilot;
// move to Redis or a DB table before scaling past one server instance.
const otpStore = new Map();

function isCollegeEmail(email) {
  const domain = process.env.COLLEGE_EMAIL_DOMAIN;
  return email.toLowerCase().endsWith('@' + domain.toLowerCase());
}

async function sendOtpEmail(email, code) {
  // Preferred path: Brevo. Sends over HTTPS (works on Render's free tier,
  // unlike SMTP), and — unlike Resend's free test mode — can send to ANY
  // recipient once a single sender address is verified, no domain needed.
  if (process.env.BREVO_API_KEY) {
    try {
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: {
            name: process.env.MAIL_FROM_NAME || 'Trinity Ride',
            email: process.env.MAIL_FROM_EMAIL,
          },
          to: [{ email }],
          subject: 'Your Trinity Ride verification code',
          textContent: `Your Trinity Ride code is ${code}. It expires in 10 minutes.`,
        }),
      });
      if (!resp.ok) {
        console.error('Brevo failed:', resp.status, await resp.text());
        console.log(`[fallback] OTP for ${email}: ${code}`);
      }
    } catch (err) {
      console.error('Brevo request error:', err);
      console.log(`[fallback] OTP for ${email}: ${code}`);
    }
    return;
  }

  // Secondary path: Resend. Only actually delivers to the email address that
  // owns the Resend account, unless a domain is verified there — kept here
  // as a fallback for testing with your own inbox, not for real students.
  if (process.env.RESEND_API_KEY) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'Trinity Ride <onboarding@resend.dev>',
          to: email,
          subject: 'Your Trinity Ride verification code',
          text: `Your Trinity Ride code is ${code}. It expires in 10 minutes.`,
        }),
      });
      if (!resp.ok) {
        console.error('Resend failed:', resp.status, await resp.text());
        console.log(`[fallback] OTP for ${email}: ${code}`); // still visible in logs if the send fails
      }
    } catch (err) {
      console.error('Resend request error:', err);
      console.log(`[fallback] OTP for ${email}: ${code}`);
    }
    return;
  }

  // Fallback path: real SMTP (works locally, blocked on hosts like Render free tier).
  if (process.env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: `"Trinity Ride" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your Trinity Ride verification code',
      text: `Your code is ${code}. It expires in 10 minutes.`,
    });
    return;
  }

  // Nothing configured — log instead, same as before.
  console.log(`[dev] OTP for ${email}: ${code}`);
}

// POST /api/auth/register
// Creates an unverified account and emails an OTP to the college address.
router.post('/register', async (req, res) => {
  try {
    const { full_name, college_email, id_card_number, phone, branch, year_of_study, password } = req.body;

    if (!full_name || !college_email || !id_card_number || !password) {
      return res.status(400).json({ error: 'Full name, college email, ID card number and password are required.' });
    }
    if (!isCollegeEmail(college_email)) {
      return res.status(400).json({ error: `Registration is open to @${process.env.COLLEGE_EMAIL_DOMAIN} addresses only.` });
    }

    const [existing] = await pool.query(
      'SELECT id, is_verified FROM users WHERE college_email = ? OR id_card_number = ?',
      [college_email, id_card_number]
    );

    let userId;
    if (existing.length > 0) {
      if (existing[0].is_verified) {
        // Genuinely already has a working account — don't let register silently overwrite it.
        return res.status(409).json({ error: 'An account with this email or ID card number already exists. Log in instead.' });
      }
      // Started signing up before but never entered the OTP — update their details and
      // send a fresh code rather than blocking them from trying again.
      const password_hash = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE users SET full_name=?, phone=?, branch=?, year_of_study=?, password_hash=? WHERE id=?`,
        [full_name, phone || null, branch || null, year_of_study || null, password_hash, existing[0].id]
      );
      userId = existing[0].id;
    } else {
      const password_hash = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        `INSERT INTO users (full_name, college_email, id_card_number, phone, branch, year_of_study, password_hash, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, FALSE)`,
        [full_name, college_email, id_card_number, phone || null, branch || null, year_of_study || null, password_hash]
      );
      userId = result.insertId;
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(college_email, { code, expires: Date.now() + 10 * 60 * 1000 });
    await sendOtpEmail(college_email, code);

    res.status(201).json({ userId, message: 'Check your college email for a verification code.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

// POST /api/auth/verify-otp
// Confirms the code, marks the account verified, and returns a JWT.
router.post('/verify-otp', async (req, res) => {
  try {
    const { college_email, code } = req.body;
    const record = otpStore.get(college_email);

    if (!record || record.expires < Date.now()) {
      return res.status(400).json({ error: 'Code expired or not found. Request a new one.' });
    }
    if (record.code !== code) {
      return res.status(400).json({ error: 'Incorrect code.' });
    }

    await pool.query('UPDATE users SET is_verified = TRUE WHERE college_email = ?', [college_email]);
    otpStore.delete(college_email);

    const [[user]] = await pool.query('SELECT id, full_name, college_email FROM users WHERE college_email = ?', [college_email]);
    const token = jwt.sign({ id: user.id, email: user.college_email }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });

    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not verify code.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { college_email, password } = req.body;
    const [[user]] = await pool.query('SELECT * FROM users WHERE college_email = ?', [college_email]);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    if (!user.is_verified) {
      return res.status(403).json({ error: 'Account not verified yet. Check your college email for a code.' });
    }

    const token = jwt.sign({ id: user.id, email: user.college_email }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
    res.json({
      token,
      user: {
        id: user.id, full_name: user.full_name, college_email: user.college_email,
        id_card_number: user.id_card_number, branch: user.branch, year_of_study: user.year_of_study,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// In-memory reset-code store, same approach as the signup OTP store.
const resetStore = new Map();

// POST /api/auth/forgot-password
// Always responds the same way whether or not the email exists, so this
// endpoint can't be used to check which emails are registered.
router.post('/forgot-password', async (req, res) => {
  try {
    const { college_email } = req.body;
    if (!college_email) return res.status(400).json({ error: 'College email is required.' });

    const [[user]] = await pool.query('SELECT id FROM users WHERE college_email = ?', [college_email]);
    if (user) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      resetStore.set(college_email, { code, expires: Date.now() + 10 * 60 * 1000 });
      await sendOtpEmail(college_email, code); // same mailer/dev-console fallback as signup
    }
    res.json({ message: 'If that email has an account, a reset code has been sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not process the request.' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { college_email, code, new_password } = req.body;
    if (!college_email || !code || !new_password) {
      return res.status(400).json({ error: 'Email, code and a new password are required.' });
    }
    const record = resetStore.get(college_email);
    if (!record || record.expires < Date.now() || record.code !== code) {
      return res.status(400).json({ error: 'Code is invalid or expired. Request a new one.' });
    }
    const password_hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = ? WHERE college_email = ?', [password_hash, college_email]);
    resetStore.delete(college_email);
    res.json({ message: 'Password updated. You can log in now.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

module.exports = router;