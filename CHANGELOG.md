# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Configurable dashed or solid separators after every tool row, using Pi Theme color tokens.
- Configurable Pi Theme color token for the native USER message-box border.

## [0.1.0] - 2026-07-25

### Added
- First standalone release as `@pure/pi-tool-display`.
- Rendering-only architecture at Pi's final tool-row seam, avoiding executable-tool re-registration, wrapping, ownership conflicts, and registration-order races.
- Compact Pi tool rows, trustworthy tool-provided diffs, display presets, and configurable output modes.
- Support for stable Pi releases from `0.81.1` onward.
