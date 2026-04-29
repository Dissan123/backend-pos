// src/routes/index.js

const express = require('express');
const router = express.Router();

const { authenticate, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

// Controllers
const authCtrl = require('../controllers/authController');
const productsCtrl = require('../controllers/productsController');
const salesCtrl = require('../controllers/salesController');
const syncCtrl = require('../controllers/syncController');
const inventoryCtrl = require('../controllers/inventoryController');

// ─── Auth ─────────────────────────────────────────────────────
router.post('/auth/signup',        authCtrl.signup);
router.post('/auth/verify-email',  authCtrl.verifyEmail);
router.post('/auth/login',         authCtrl.login);
router.post('/auth/verify-otp',    authCtrl.verifyOTP);
router.post('/auth/google',        authCtrl.googleAuth);
router.post('/auth/resend-otp',    authCtrl.resendOTP);
router.get( '/auth/me',            authenticate, authCtrl.getMe);
router.post('/auth/register',      authenticate, requireAdmin, authCtrl.register);

// ─── Products ─────────────────────────────────────────────────
router.get('/products/categories', authenticate, productsCtrl.getCategories);
router.get('/products/barcode/:barcode', authenticate, productsCtrl.getProductByBarcode);
router.get('/products', authenticate, productsCtrl.getProducts);
router.get('/products/:id', authenticate, productsCtrl.getProduct);
router.post('/products', authenticate, requireAdmin, productsCtrl.createProduct);
router.put('/products/:id', authenticate, requireAdmin, productsCtrl.updateProduct);
router.patch('/products/:id/stock', authenticate, requireAdmin, productsCtrl.updateStock);
router.delete('/products/:id', authenticate, requireAdmin, productsCtrl.deleteProduct);

// ─── Sales ────────────────────────────────────────────────────
router.get('/sales/summary/today', authenticate, salesCtrl.getTodaySummary);
router.get('/sales/receipt/:receiptNumber', authenticate, salesCtrl.getSaleByReceipt);
router.get('/sales', authenticate, salesCtrl.getSales);
router.get('/sales/:id', authenticate, salesCtrl.getSale);
router.post('/sales', authenticate, salesCtrl.createSale);
router.post('/sales/:id/void', authenticate, requireAdmin, salesCtrl.voidSale);

// ─── Inventory ────────────────────────────────────────────────
router.get('/inventory/logs', authenticate, inventoryCtrl.getLogs);
router.get('/inventory/low-stock', authenticate, inventoryCtrl.getLowStock);

// ─── Reports ──────────────────────────────────────────────────
router.get('/reports/sales', authenticate, inventoryCtrl.getSalesReport);

// ─── Settings ─────────────────────────────────────────────────
router.get('/settings', authenticate, inventoryCtrl.getSettings);
router.put('/settings', authenticate, requireAdmin, inventoryCtrl.updateSettings);

// ─── Receipts ─────────────────────────────────────────────────
const receiptCtrl = require('../controllers/receiptController');
router.get('/receipts/:saleId/pdf',          authenticate, receiptCtrl.downloadReceiptPdf);
router.get('/receipts/:saleId/thermal-data', authenticate, receiptCtrl.getThermalData);

// ─── Analytics ────────────────────────────────────────────────
const analyticsCtrl = require('../controllers/analyticsController');
router.get('/analytics/overview',           authenticate, analyticsCtrl.getOverview);
router.get('/analytics/revenue-trend',      authenticate, analyticsCtrl.getRevenueTrend);
router.get('/analytics/top-products',       authenticate, analyticsCtrl.getTopProducts);
router.get('/analytics/category-breakdown', authenticate, analyticsCtrl.getCategoryBreakdown);
router.get('/analytics/hourly-heatmap',     authenticate, analyticsCtrl.getHourlyHeatmap);
router.get('/analytics/cashier-performance',authenticate, analyticsCtrl.getCashierPerformance);
router.get('/analytics/inventory-value',    authenticate, analyticsCtrl.getInventoryValue);
router.get('/analytics/profit',             authenticate, analyticsCtrl.getProfitAnalysis);
router.get('/analytics/staff',              authenticate, analyticsCtrl.getStaffLeaderboard);
router.get('/analytics/live',               authenticate, analyticsCtrl.getLive);

// ─── Users (admin only) ───────────────────────────────────────
const usersCtrl = require('../controllers/usersController');
router.get('/users',                   authenticate, requireAdmin, usersCtrl.getUsers);
router.get('/users/:id',               authenticate, requireAdmin, usersCtrl.getUser);
router.post('/users',                  authenticate, requireAdmin, usersCtrl.createUser);
router.put('/users/:id',               authenticate, requireAdmin, usersCtrl.updateUser);
router.patch('/users/:id/status',      authenticate, requireAdmin, usersCtrl.setUserStatus);
router.patch('/users/:id/password',    authenticate, usersCtrl.changePassword);
router.get('/users/:id/activity',      authenticate, requireAdmin, usersCtrl.getUserActivity);

// ─── PesaPal Mobile Money ──────────────────────────────────────
const pesapalCtrl = require('../controllers/pesapalController');
router.get('/pesapal/config',           authenticate, pesapalCtrl.getConfig);
router.post('/pesapal/initiate',        authenticate, pesapalCtrl.initiatePayment);
router.get('/pesapal/status/:orderTrackingId', authenticate, pesapalCtrl.checkStatus);
router.get('/pesapal/ipn',              pesapalCtrl.handleIpn); // Public — called by PesaPal servers

// ─── Stock Orders & Warehouse ────────────────────────────────────
const stockOrderCtrl = require('../controllers/stockOrderController');
router.get('/warehouse',                      authenticate, requireAdmin, stockOrderCtrl.getWarehouse);
router.get('/warehouse/catalogue',            authenticate, stockOrderCtrl.getCatalogue);  // cashiers can see this
router.patch('/warehouse/:id/restock',        authenticate, requireAdmin, stockOrderCtrl.restockWarehouse);
router.get('/stock-orders/summary',           authenticate, stockOrderCtrl.getSummary);
router.get('/stock-orders',                   authenticate, stockOrderCtrl.getOrders);
router.get('/stock-orders/:id',               authenticate, stockOrderCtrl.getOrder);
router.post('/stock-orders',                  authenticate, stockOrderCtrl.createOrder);
router.patch('/stock-orders/:id/approve',     authenticate, requireAdmin, stockOrderCtrl.approveOrder);
router.patch('/stock-orders/:id/reject',      authenticate, requireAdmin, stockOrderCtrl.rejectOrder);

// ─── Branches ────────────────────────────────────────────────────
const branchCtrl = require('../controllers/branchController');
router.get('/branches',                    authenticate, branchCtrl.getBranches);
router.get('/branches/compare',            authenticate, branchCtrl.compareBranches);
router.get('/branches/:id',                authenticate, branchCtrl.getBranch);
router.post('/branches',                   authenticate, requireAdmin, branchCtrl.createBranch);
router.put('/branches/:id',                authenticate, requireAdmin, branchCtrl.updateBranch);
router.patch('/branches/:id/status',       authenticate, requireAdmin, branchCtrl.setBranchStatus);
router.patch('/users/:id/branch',          authenticate, requireAdmin, branchCtrl.assignUserToBranch);

// ─── Sync ─────────────────────────────────────────────────────
router.post('/sync',             authenticate, syncCtrl.triggerSync);
router.get('/sync/status',       authenticate, syncCtrl.getStatus);
router.post('/sync/retry',       authenticate, requireAdmin, syncCtrl.retrySync);
router.get('/sync/diagnose',     authenticate, syncCtrl.diagnose);
router.post('/sync/queue-all',    authenticate, requireAdmin, syncCtrl.queueAll);

// ─── Superadmin (Developer) ───────────────────────────────────────
const superCtrl = require('../controllers/superController');
router.post('/super/login',                                   superCtrl.login);
router.get( '/super/stats',                  authenticate, requireSuperAdmin, superCtrl.getPlatformStats);
router.get( '/super/enterprises',            authenticate, requireSuperAdmin, superCtrl.getEnterprises);
router.get( '/super/enterprises/:id',        authenticate, requireSuperAdmin, superCtrl.getEnterprise);
router.patch('/super/enterprises/:id',       authenticate, requireSuperAdmin, superCtrl.updateEnterprise);
router.delete('/super/enterprises/:id',      authenticate, requireSuperAdmin, superCtrl.deleteEnterprise);
router.post('/super/enterprises/:id/impersonate', authenticate, requireSuperAdmin, superCtrl.impersonate);
router.get( '/super/users',                  authenticate, requireSuperAdmin, superCtrl.getAllUsers);
router.patch('/super/users/:id',             authenticate, requireSuperAdmin, superCtrl.updateUser);
router.delete('/super/users/:id',            authenticate, requireSuperAdmin, superCtrl.deleteUser);

module.exports = router;
