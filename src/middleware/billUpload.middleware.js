const multer = require('multer');
const path = require('path');

const uploadDirectory = path.resolve(
  __dirname,
  '../uploads/bills'
);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDirectory);
  },

  filename: (req, file, cb) => {
    const uniqueName =
      `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

    cb(
      null,
      uniqueName + path.extname(file.originalname)
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 10 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'application/pdf'
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(
        new Error('Only JPG, PNG and PDF bills are supported')
      );
    }

    return cb(null, true);
  }
});

module.exports = upload;
