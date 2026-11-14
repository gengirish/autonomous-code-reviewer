"use strict";

const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { requireUser } = require("../middleware/auth");
const { createThumbnail } = require("../services/thumbnails");

const upload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOAD_DIR || "/var/app/uploads",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = express.Router();

router.post("/uploads", requireUser, upload.single("image"), async (req, res, next) => {
  try {
    const width = Number(req.query.thumbWidth || 256);
    const thumbnail = await createThumbnail(req.file.filename, width);
    res.status(201).json({ fileName: req.file.filename, thumbnail: path.basename(thumbnail) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
