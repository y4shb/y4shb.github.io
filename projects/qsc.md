# Qualcomm Software Center
*A cross-platform Electron desktop installer that ships drivers and software to OEMs worldwide.*

Qualcomm Software Center is the desktop application OEMs use to pull software and drivers for Qualcomm silicon. It is an Electron app: a Chromium shell wrapped around an Angular front end and a Node service layer, packaged for Windows and macOS, signed, notarized, and pushed out through a release pipeline that has to land cleanly on machines in factories around the world. I worked on it for almost three years and ended up owning the release engineering for it.

The work split into three areas: shipping the first macOS universal build that ran natively on Intel and Apple Silicon, automating the release pipeline so a build stopped being a half-day of clicking, and standing up the deploy, logging, and monitoring plumbing that let the team see what was actually happening on machines after a release.

## The Apple Silicon universal build

When Apple Silicon launched, the app ran fine under Rosetta but it was not a great look to be shipping an emulated installer to a hardware vendor's partners. The path to a universal build looked simple on paper and was not. Electron itself was friendly: there was a documented universal target and a tool to fuse two arch-specific app bundles into one. The trouble was the native modules.

The app had accumulated a handful of native node modules over the years, some maintained, some not. Each one had to be rebuilt for arm64, and a few of them had to be patched first to even compile against the newer macOS SDK that the arm64 toolchain wanted. A few of them had transitive dependencies on prebuilt binaries that shipped only as Intel. For each one the answer was a different mix of upgrading the dependency, swapping it out, or pinning a fork. None of that was interesting work on its own; what was interesting was getting it all to converge into a single CI job that could produce, sign, notarize, and staple a universal bundle every time, with no manual steps.

The shipped artifact is one Application bundle that contains both slices. It launches natively on either architecture, the installer flow is identical, and the analytics on it after a few release cycles showed Rosetta usage on this app drop to effectively zero. That was the goal.

## Cutting the release in half

The release process when I picked it up was a runbook. A build engineer would tag the release in source control, kick off a Jenkins job, wait for it to produce per-arch artifacts, download them, run the signing and notarization steps locally, upload to S3, update a manifest, smoke test the installer on a few VMs, and post in a channel. The whole loop took most of a day. Most steps were obvious automation candidates that had not been done because the team was always busy shipping the next thing.

I rewrote the pipeline end to end. The Jenkins side became a single parameterized job that fanned out into the per-arch builds, a fuse step for the universal Mac bundle, signing and notarization as pipeline stages with their secrets pulled from a vault, an upload to the S3 distribution bucket, and a manifest update that flipped the channel pointer at the end. The smoke tests moved into the pipeline as well, running the installer against a small matrix of Windows and macOS images and capturing the install log as an artifact on failure.

The end-to-end release time dropped by about half. The bigger win was that the release stopped depending on any one person being at their desk. A release was a button now, and the button worked the same way at 9 am or at midnight.

## Deploy, logging, monitoring

The third slice was visibility. The app talked to a small backend for telemetry, update checks, and signed manifest serving. Most of that lived in AWS and had grown the usual collection of one-off scripts. I consolidated the deploy story onto a single pipeline that pushed the backend, the static distribution bucket, and the manifest in lockstep, so a release of the app never landed pointing at a backend that did not yet know about it.

For logging and monitoring, I wired the app's update flow and the backend's manifest endpoint into a small dashboard that the team could actually read. Failed updates were the most important signal, and we wanted to catch a bad release before an OEM did. The dashboard showed update success rate by version and platform, error breakdown by class, and a rolling tail of the most recent failures with enough context to reproduce them. Twice in my time there a bad signing certificate was caught by the dashboard within minutes of going out, and rolled back before it reached any partners.

## What shipped

What shipped, in the end, was a release pipeline that the team trusted and a desktop app that ran cleanly on any modern Mac or Windows machine the OEMs threw at it. The Electron stack stayed boring on purpose. The interesting work was in the pipeline around it.
