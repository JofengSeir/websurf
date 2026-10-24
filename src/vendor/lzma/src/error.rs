use std::fmt;
use std::error;
use std::io;

/// Errors for `Reader` and `Writer`.
#[derive(Debug)]
pub enum Error {
	/// A downstream IO error.
	IO(io::Error),

	/// The stream is corrupted.
	Corrupted,

	/// Invalid model values.
	InvalidProperties,

	/// The EOS marker is missing.
	MissingMarker,

	/// The stream has more data but the uncompressed size has been reached.
	HasMoreData,

	/// The stream has finished but the uncompressed size has not been reached.
	NeedMoreData,

	/// The stream has finished unexpectedly with a marker.
	FinishedWithMarker,
}

impl From<io::Error> for Error {
	fn from(value: io::Error) -> Self {
		Error::IO(value)
	}
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		match self {
			Error::IO(err) => err.fmt(f),
			Error::Corrupted => f.write_str("The LZMA stream is corrupted."),
			Error::InvalidProperties => f.write_str("Invalid model values."),
			Error::MissingMarker => f.write_str("The EOS marker is missing."),
			Error::HasMoreData => f.write_str("The stream has more data but the uncompressed size has been reached."),
			Error::NeedMoreData => f.write_str("The stream has finished but the uncompressed size has not been reached."),
			Error::FinishedWithMarker => f.write_str("The stream finished unexpectedly with a marker."),
		}
	}
}

impl error::Error for Error {
	fn source(&self) -> Option<&(dyn error::Error + 'static)> {
		match self {
			Error::IO(err) => Some(err),
			_ => None,
		}
	}
}
