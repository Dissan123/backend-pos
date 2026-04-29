// src/middleware/auth.js
'use strict';

const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'No token provided' });

  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const requireAdmin = (req, res, next) => {
  const role = req.user?.role;
  // superadmin can do everything an admin can
  if (role === 'admin' || role === 'owner' || role === 'superadmin') return next();
  return res.status(403).json({ success: false, message: 'Admin access required' });
};

const requireSuperAdmin = (req, res, next) => {
  if (req.user?.role !== 'superadmin')
    return res.status(403).json({ success: false, message: 'Superadmin access required' });
  next();
};

const requireSelfOrAdmin = (req, res, next) => {
  const role = req.user?.role;
  if (role === 'admin' || role === 'owner' || role === 'superadmin' || req.user?.id === req.params.id)
    return next();
  return res.status(403).json({ success: false, message: 'Access denied' });
};

module.exports = { authenticate, requireAdmin, requireSuperAdmin, requireSelfOrAdmin };
