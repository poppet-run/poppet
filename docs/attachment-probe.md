# Documents and local voice compatibility

[Documentation index](README.md) · [Telegram usage](gateways/telegram.md#documents-and-voice)

Probed on macOS arm64 with Bun 1.4.3 on 2026-10-21. These measurements cover local
processing of disposable fixtures, independently of Telegram and model inference.

## PDF choice

No suitable parser was installed. The gateway now pins
[unpdf 1.9.1](https://github.com/unjs/unpdf), which packages a serverless PDF.js
build without requiring a system PDF utility or native canvas dependency.
A two-page fixture retained `Café résumé` and separate page boundaries: about
63 ms elapsed and 56.2 MiB process RSS in the initial probe. Automated checks also
exercise encrypted, malformed, empty, oversized-page-count and excerpted PDFs.

Each PDF runs in an owned Bun subprocess, killed and reaped on cancellation,
failure or its 30-second deadline. It reads local bytes only, disables fetch,
JavaScript evaluation, system font use and automatic resource fetching, and calls
only text extraction APIs. It does not execute embedded document actions or
extract embedded files. No OCR is attempted.

Eight MiB input, 64 pages and 32 KiB output bound the accepted workload. These
limits and process isolation are not an operating-system RSS quota; a difficult
page can consume more memory before the deadline. Extracted text does not prove
that tables, images, reading order or layout were understood.

## Local voice choice

The owner selected local transcription. A cloud service was therefore excluded
from this implementation; no audio API, credentials, billing or service retention
policy is involved. Telegram still supplies the original recording, and the
accepted transcript enters the configured text model's context.

The tested tools were [FFmpeg 8.0.1](https://ffmpeg.org/releases/) and
[whisper.cpp v1.9.5](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5),
built in a disposable directory. whisper.cpp used its CPU backend, four threads,
automatic language detection and the multilingual `ggml-tiny.bin` model.
The tested model's SHA-256 was
`be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21`.
Larger compatible models may improve recognition but were not measured.

The upstream JFK sample was converted to Ogg/Opus, then passed through the actual
Poppet processor. It produced the expected sentence, took about 323 ms overall
(15 ms decoding and 305 ms transcription), and left no temporary files.
Subprocess peak RSS was about 8.8 MiB for FFmpeg and 178.1 MiB for whisper.cpp.
These are one short sample with a warm filesystem cache, not a latency or accuracy
guarantee for phone recordings, other languages, machines or models.

FFmpeg accepts Ogg input with local-file protocol access only and writes mono
16 kHz PCM WAV. The host checks decoded duration, independently of Telegram's
metadata, before invoking whisper.cpp. The decoder stops at 121 seconds so an
over-limit recording can be rejected without decoding an unbounded stream.
Decoding has a 30-second deadline; transcription has a separate 90-second deadline.
The accepted transcript is limited to 16 KiB.

Install FFmpeg, a compatible whisper-cli build, and a compatible local speech
model in permanent locations before enabling voice. See the upstream
[whisper.cpp build and model instructions](https://github.com/ggml-org/whisper.cpp#quick-start).
Poppet does not download tools or models at runtime. Absolute executable/model
paths are owner configuration; no uploaded filename becomes a command or path.

## Validation still requiring a live chat

Use the [Telegram manual checks](gateways/telegram.md#manual-validation) for actual
bot file downloads, permissions, model grounding, speech accuracy and the reminder
confirmation flow. Automated fixtures and the local sample do not validate those
remote paths. Voice remains off until explicitly configured.
