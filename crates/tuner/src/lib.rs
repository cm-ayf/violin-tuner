use rustfft::{Fft, FftPlanner, num_complex::Complex};
use std::{f32::consts::PI, sync::Arc};
use wasm_bindgen::prelude::*;

const RANGE_CENTS: f32 = 100.0;
const AMPLITUDE_PER_HZ: f32 = 0.00025 / (442.0 * 4.0 / 9.0);

fn minimum_amplitude(target_hz: f32) -> f32 {
    target_hz * AMPLITUDE_PER_HZ
}

fn focus_string(readings: &[f32]) -> Option<usize> {
    let strongest = (0_usize..4)
        .filter(|&index| readings[1 + index * 3] > 0.0)
        .max_by(|&a, &b| readings[3 + a * 3].total_cmp(&readings[3 + b * 3]))?;
    let neighbor = (0_usize..4)
        .filter(|&index| index.abs_diff(strongest) == 1 && readings[1 + index * 3] > 0.0)
        .max_by_key(|&index| index.abs_diff(2));
    Some(match neighbor {
        Some(index) if index.abs_diff(2) > strongest.abs_diff(2) => index,
        _ => strongest,
    })
}

#[wasm_bindgen]
pub struct Analyzer {
    frame_size: usize,
    targets: [f32; 4],
    fft: Arc<dyn Fft<f32>>,
    buffer: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    window: Vec<f32>,
    magnitudes: Vec<f32>,
    floor_samples: Vec<f32>,
    window_sum: f32,
}

#[wasm_bindgen]
impl Analyzer {
    #[wasm_bindgen(constructor)]
    pub fn new(frame_size: usize, targets: &[f32]) -> Result<Analyzer, String> {
        if !(32..=32768).contains(&frame_size) || !frame_size.is_power_of_two() {
            return Err("Frame size must be a power of two between 32 and 32768".into());
        }
        let targets: [f32; 4] = targets
            .try_into()
            .map_err(|_| "Expected four targets in G/D/A/E order".to_string())?;
        if targets
            .iter()
            .any(|target| !target.is_finite() || *target <= 0.0)
            || targets.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err("Targets must be finite, positive, and strictly increasing".into());
        }
        let fft_size = frame_size * 4;
        let fft = FftPlanner::new().plan_fft_forward(fft_size);
        let window: Vec<f32> = (0..frame_size)
            .map(|i| {
                // Blackman-Harris sidelobe suppression keeps a loud D from masking a quiet G.
                let phase = 2.0 * PI * i as f32 / (frame_size - 1) as f32;
                0.35875 - 0.48829 * phase.cos() + 0.14128 * (2.0 * phase).cos()
                    - 0.01168 * (3.0 * phase).cos()
            })
            .collect();
        let window_sum = window.iter().sum();
        Ok(Self {
            frame_size,
            targets,
            scratch: vec![Complex::default(); fft.get_inplace_scratch_len()],
            fft,
            buffer: vec![Complex::default(); fft_size],
            magnitudes: vec![0.0; fft_size / 2],
            floor_samples: Vec::with_capacity(fft_size / 2),
            window,
            window_sum,
        })
    }

    // Output: RMS, [Hz (0 = undetected), cents, dBFS] per G/D/A/E, focus index (-1 = none).
    pub fn analyze(&mut self, samples: &[f32], sample_rate: f32) -> Result<Vec<f32>, String> {
        if samples.len() != self.frame_size {
            return Err(format!("Expected {} audio samples", self.frame_size));
        }
        if !sample_rate.is_finite() || !(8000.0..=192000.0).contains(&sample_rate) {
            return Err("Unsupported sample rate (expected 8000–192000 Hz)".into());
        }
        let bin_hz = sample_rate / self.buffer.len() as f32;
        let bands = self.targets.map(|target| {
            (
                target * 2.0_f32.powf(-RANGE_CENTS / 1200.0),
                target * 2.0_f32.powf(RANGE_CENTS / 1200.0),
            )
        });
        if bands.iter().any(|(low, high)| {
            (low / bin_hz).floor() < 1.0
                || (high / bin_hz).ceil() >= (self.magnitudes.len() - 1) as f32
        }) {
            return Err("Target search bands do not fit the frame size and sample rate".into());
        }
        if samples.iter().any(|sample| !sample.is_finite()) {
            return Err("Audio samples must be finite".into());
        }
        let mean = samples.iter().sum::<f32>() / self.frame_size as f32;
        let rms = (samples.iter().map(|s| (s - mean).powi(2)).sum::<f32>()
            / self.frame_size as f32)
            .sqrt();
        let mut result = vec![rms];
        for _ in self.targets {
            result.extend_from_slice(&[0.0, 0.0, -120.0]);
        }
        result.push(-1.0);
        if rms < minimum_amplitude(self.targets[0]) / 2.0 {
            return Ok(result);
        }
        self.buffer.fill(Complex::default());
        for (i, sample) in samples.iter().enumerate() {
            self.buffer[i].re = (sample - mean) * self.window[i];
        }
        self.fft
            .process_with_scratch(&mut self.buffer, &mut self.scratch);
        for (i, magnitude) in self.magnitudes.iter_mut().enumerate() {
            *magnitude = self.buffer[i].norm() * 2.0 / self.window_sum;
        }
        self.floor_samples.clear();
        self.floor_samples.extend_from_slice(
            &self.magnitudes[(100.0 / bin_hz) as usize..(1500.0 / bin_hz) as usize],
        );
        let middle = self.floor_samples.len() / 2;
        let (_, median, _) = self
            .floor_samples
            .select_nth_unstable_by(middle, f32::total_cmp);
        let noise_threshold = *median * 8.0;
        for (string, target) in self.targets.iter().enumerate() {
            let threshold = noise_threshold.max(minimum_amplitude(*target));
            let (low_hz, high_hz) = bands[string];
            let low = (low_hz / bin_hz).floor() as usize;
            let high = (high_hz / bin_hz).ceil() as usize;
            let peak = (low..=high)
                .max_by(|a, b| self.magnitudes[*a].total_cmp(&self.magnitudes[*b]))
                .expect("Frequency search band is nonempty");
            let amplitude = self.magnitudes[peak];
            if amplitude < threshold
                || amplitude <= self.magnitudes[peak - 1]
                || amplitude <= self.magnitudes[peak + 1]
            {
                continue;
            }
            // Log-parabolic interpolation of the zero-padded spectrum reduces bin bias.
            let left = self.magnitudes[peak - 1].max(1e-12).ln();
            let center = amplitude.ln();
            let right = self.magnitudes[peak + 1].max(1e-12).ln();
            let offset = 0.5 * (left - right) / (left - 2.0 * center + right);
            let frequency = (peak as f32 + offset) * bin_hz;
            if !(low_hz..=high_hz).contains(&frequency) {
                continue;
            }
            let index = 1 + string * 3;
            result[index] = frequency;
            result[index + 1] = 1200.0 * (frequency / target).log2();
            result[index + 2] = 20.0 * amplitude.max(1e-6).log10();
        }
        result[13] = focus_string(&result).map_or(-1.0, |index| index as f32);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME_SIZE: usize = 16384;
    const TARGETS: [f32; 4] = [442.0 * 4.0 / 9.0, 442.0 * 2.0 / 3.0, 442.0, 663.0];

    fn signal(rate: f32, tones: &[(f32, f32)]) -> Vec<f32> {
        signal_with_size(FRAME_SIZE, rate, tones)
    }

    fn signal_with_size(frame_size: usize, rate: f32, tones: &[(f32, f32)]) -> Vec<f32> {
        (0..frame_size)
            .map(|i| {
                tones
                    .iter()
                    .map(|(hz, level)| level * (2.0 * PI * hz * i as f32 / rate).sin())
                    .sum()
            })
            .collect()
    }

    fn noise(level: f32, mut seed: u32) -> Vec<f32> {
        (0..FRAME_SIZE)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed as f32 / u32::MAX as f32 - 0.5) * level
            })
            .collect()
    }

    #[test]
    fn constructor_uses_supplied_frame_size_and_targets() {
        let targets = [430.0 * 4.0 / 9.0, 430.0 * 2.0 / 3.0, 430.0, 645.0];
        for frame_size in [4096, 8192, 16384, 32768] {
            let mut analyzer = Analyzer::new(frame_size, &targets).unwrap();
            assert_eq!(analyzer.buffer.len(), frame_size * 4);
            assert_eq!(analyzer.window.len(), frame_size);
            for (index, target) in targets.iter().enumerate() {
                let hz = target * 2.0_f32.powf(37.0 / 1200.0);
                let samples = signal_with_size(frame_size, 48000.0, &[(hz, 0.3)]);
                let result = analyzer.analyze(&samples, 48000.0).unwrap();
                assert_eq!(result.len(), 14);
                assert!(
                    (result[2 + index * 3] - 37.0).abs() < 1.0,
                    "{frame_size}, {target}: {result:?}"
                );
                assert_eq!(result[13], index as f32);
            }
            assert!(
                analyzer
                    .analyze(&vec![0.0; frame_size / 2], 48000.0)
                    .is_err()
            );
        }
    }

    #[test]
    fn minimum_threshold_scales_continuously_with_frequency() {
        for (target, expected) in TARGETS
            .into_iter()
            .zip([0.00025, 0.000375, 0.0005625, 0.00084375])
        {
            assert!((minimum_amplitude(target) - expected).abs() < 1e-9);
            assert!((minimum_amplitude(target * 2.0) - expected * 2.0).abs() < 1e-9);
        }
        for hz in [100.0, 220.0, 250.0, 350.0, 500.0, 1000.0] {
            assert!(minimum_amplitude(hz + 1.0) > minimum_amplitude(hz));
        }
        // The same frequency gets the same threshold regardless of its string index.
        for targets in [[160.0, 250.0, 400.0, 600.0], [250.0, 400.0, 600.0, 900.0]] {
            let mut analyzer = Analyzer::new(FRAME_SIZE, &targets).unwrap();
            for (index, target) in targets.iter().enumerate() {
                for (scale, detected) in [(0.8, false), (1.2, true)] {
                    let samples = signal(48000.0, &[(*target, minimum_amplitude(*target) * scale)]);
                    let result = analyzer.analyze(&samples, 48000.0).unwrap();
                    assert_eq!(
                        result[1 + index * 3] > 0.0,
                        detected,
                        "{target}, {scale}: {result:?}"
                    );
                    assert_eq!(result[13], if detected { index as f32 } else { -1.0 });
                }
            }
        }
    }

    #[test]
    fn constructor_rejects_invalid_configuration() {
        for size in [0, 1, 16, 33, 1023, 32769, 65536] {
            assert!(Analyzer::new(size, &TARGETS).is_err(), "{size}");
        }
        for size in [32, 32768] {
            assert!(Analyzer::new(size, &TARGETS).is_ok(), "{size}");
        }
        for targets in [
            vec![],
            vec![100.0, 200.0, 300.0],
            vec![100.0, 200.0, 300.0, 400.0, 500.0],
            vec![0.0, 200.0, 300.0, 400.0],
            vec![-100.0, 200.0, 300.0, 400.0],
            vec![f32::NAN, 200.0, 300.0, 400.0],
            vec![100.0, 200.0, 300.0, f32::INFINITY],
            vec![100.0, 200.0, 200.0, 400.0],
            vec![200.0, 100.0, 300.0, 400.0],
        ] {
            assert!(Analyzer::new(FRAME_SIZE, &targets).is_err(), "{targets:?}");
        }
    }

    #[test]
    fn rejects_search_bands_outside_the_fft_instead_of_panicking() {
        for (frame_size, targets, sample_rate) in [
            (32, TARGETS, 192000.0),
            (FRAME_SIZE, [0.001, 200.0, 300.0, 400.0], 48000.0),
            (FRAME_SIZE, [100.0, 200.0, 300.0, 4000.0], 8000.0),
            (FRAME_SIZE, [100.0, 200.0, 300.0, f32::MAX], 48000.0),
        ] {
            let mut analyzer = Analyzer::new(frame_size, &targets).unwrap();
            assert!(
                analyzer
                    .analyze(&vec![0.0; frame_size], sample_rate)
                    .is_err()
            );
        }
    }

    #[test]
    fn quiet_g_is_detected_below_old_amplitude_and_rms_gates() {
        let mut analyzer = Analyzer::new(FRAME_SIZE, &TARGETS).unwrap();
        for rate in [44100.0, 48000.0, 96000.0] {
            for cents in [-80.0, -20.0, 0.0, 25.0, 80.0] {
                let hz = TARGETS[0] * 2.0_f32.powf(cents / 1200.0);
                for g_level in [0.0004, 0.0008] {
                    for d_level in [0.0, 0.3] {
                        let samples = signal(rate, &[(hz, g_level), (TARGETS[1], d_level)]);
                        let result = analyzer.analyze(&samples, rate).unwrap();
                        assert!(
                            result[1] > 0.0,
                            "Missing quiet G: {rate} Hz, {cents} cents, G={g_level}, D={d_level}"
                        );
                        assert_eq!(result[13], 0.0);
                        assert!(
                            (result[2] - cents).abs() < 1.0,
                            "{rate} Hz, {cents} cents, G={g_level}, D={d_level}: {result:?}"
                        );
                        assert!((result[3] - 20.0 * g_level.log10()).abs() < 0.5);
                        assert_eq!(result[4] > 0.0, d_level > 0.0);
                    }
                }
            }
        }
    }

    #[test]
    fn d_harmonics_do_not_trigger_g_at_increased_sensitivity() {
        let mut analyzer = Analyzer::new(FRAME_SIZE, &TARGETS).unwrap();
        for rate in [44100.0, 48000.0, 96000.0] {
            for cents in [-80.0, 0.0, 80.0] {
                let hz = TARGETS[1] * 2.0_f32.powf(cents / 1200.0);
                for level in [0.01, 0.3, 0.8] {
                    let samples = signal(
                        rate,
                        &[
                            (hz, level),
                            (hz * 2.0, level * 0.6),
                            (hz * 3.0, level * 0.35),
                            (hz * 4.0, level * 0.2),
                        ],
                    );
                    let result = analyzer.analyze(&samples, rate).unwrap();
                    assert_eq!(
                        result[1], 0.0,
                        "False G: {rate} Hz, D={hz}, level={level}: {result:?}"
                    );
                    assert_eq!(result[13], 1.0);
                }
            }
        }
    }

    #[test]
    fn frequency_dependent_sensitivity_preserves_noise_rejection() {
        let mut analyzer = Analyzer::new(FRAME_SIZE, &TARGETS).unwrap();
        for rate in [44100.0, 48000.0, 96000.0] {
            for level in [0.0002, 0.001, 0.01, 0.1] {
                for seed in [42, 137, 2026] {
                    let result = analyzer.analyze(&noise(level, seed), rate).unwrap();
                    assert_eq!(
                        result[13], -1.0,
                        "Noise detected: {rate} Hz, level={level}, seed={seed}: {result:?}"
                    );
                }
            }
            let result = analyzer
                .analyze(
                    &signal(rate, &[(TARGETS[0], 0.0001), (TARGETS[1], 0.3)]),
                    rate,
                )
                .unwrap();
            assert_eq!(result[1], 0.0, "Subthreshold G detected: {result:?}");
            assert_eq!(result[13], 1.0);
        }
    }

    #[test]
    fn pure_fifths_and_detuned_strings_are_within_one_cent() {
        let mut analyzer = Analyzer::new(FRAME_SIZE, &TARGETS).unwrap();
        for rate in [44100.0, 48000.0, 96000.0] {
            for (string, target) in TARGETS.iter().enumerate() {
                for cents in [-80.0, -25.0, 0.0, 17.0, 80.0] {
                    let hz = target * 2.0_f32.powf(cents / 1200.0);
                    let result = analyzer.analyze(&signal(rate, &[(hz, 0.3)]), rate).unwrap();
                    assert_eq!(result.len(), 14);
                    assert_eq!(result[13], string as f32);
                    assert!(result[1 + string * 3] > 0.0);
                    assert!(
                        (result[2 + string * 3] - cents).abs() < 1.0,
                        "{rate} Hz, string {string}, {cents} cents: {result:?}"
                    );
                    for other in 0..4 {
                        if other != string {
                            assert_eq!(
                                result[1 + other * 3],
                                0.0,
                                "False string detection: {result:?}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn simultaneous_strings_and_harmonics() {
        let mut analyzer = Analyzer::new(FRAME_SIZE, &TARGETS).unwrap();
        let mut tones = Vec::new();
        for (index, target) in TARGETS.iter().enumerate() {
            let level = 0.12 / (index + 1) as f32;
            tones.extend([
                (target * 1.001, level),
                (target * 2.002, level * 1.5),
                (target * 3.003, level),
            ]);
        }
        let result = analyzer.analyze(&signal(48000.0, &tones), 48000.0).unwrap();
        for string in 0..4 {
            assert!(
                (result[2 + string * 3] - 1200.0 * 1.001_f32.log2()).abs() < 1.0,
                "{result:?}"
            );
            assert!(result[1 + string * 3] > 0.0);
        }
        assert!(result[3] > result[12]);
    }

    #[test]
    fn adjacent_double_stops_focus_farther_from_a_regardless_of_which_is_louder() {
        let mut analyzer = Analyzer::new(FRAME_SIZE, &TARGETS).unwrap();
        for rate in [44100.0, 48000.0, 96000.0] {
            for (lower, expected) in [(0, 0), (1, 1), (2, 3)] {
                for (low_level, high_level) in [
                    (0.2, 0.2),
                    (0.04, 0.2),
                    (0.2, 0.04),
                    (0.003, 0.3),
                    (0.3, 0.003),
                ] {
                    let samples = signal(
                        rate,
                        &[
                            (TARGETS[lower], low_level),
                            (TARGETS[lower + 1], high_level),
                        ],
                    );
                    let result = analyzer.analyze(&samples, rate).unwrap();
                    assert_eq!(
                        result[13], expected as f32,
                        "{rate} Hz, pair {lower}: {result:?}"
                    );
                    assert!(result[1 + lower * 3] > 0.0);
                    assert!(result[1 + (lower + 1) * 3] > 0.0);
                }
            }
        }
    }

    #[test]
    fn quiet_g_is_selected_alongside_louder_d() {
        let mut analyzer = Analyzer::new(FRAME_SIZE, &TARGETS).unwrap();
        let samples = signal(48000.0, &[(TARGETS[0], 0.003), (TARGETS[1], 0.3)]);
        let result = analyzer.analyze(&samples, 48000.0).unwrap();
        assert!(result[1] > 0.0);
        assert!(result[4] > 0.0);
        assert!(result[6] - result[3] > 39.0);
        assert_eq!(result[13], 0.0);
    }

    #[test]
    fn focus_uses_detection_not_a_relative_level_cutoff() {
        let mut readings = vec![
            0.1, TARGETS[0], 0.0, -38.0, TARGETS[1], 0.0, -20.0, 0.0, 0.0, -120.0, 0.0, 0.0, -120.0,
        ];
        assert_eq!(focus_string(&readings), Some(0));
        readings[3] = -38.01;
        assert_eq!(focus_string(&readings), Some(0));
        readings[3] = -60.0;
        assert_eq!(focus_string(&readings), Some(0));
        readings[1] = 0.0;
        assert_eq!(focus_string(&readings), Some(1));
    }

    #[test]
    fn rejects_silence_dc_noise_and_out_of_range_tones() {
        let mut analyzer = Analyzer::new(FRAME_SIZE, &TARGETS).unwrap();
        for samples in [
            vec![0.0; FRAME_SIZE],
            vec![0.2; FRAME_SIZE],
            noise(0.1, 42),
            signal(48000.0, &[(1000.0, 0.3)]),
            signal(48000.0, &[(442.0 * 2.0_f32.powf(130.0 / 1200.0), 0.3)]),
        ] {
            let result = analyzer.analyze(&samples, 48000.0).unwrap();
            assert_eq!(result[13], -1.0);
            for string in 0..4 {
                assert_eq!(result[1 + string * 3], 0.0, "{result:?}");
            }
        }
    }

    #[test]
    fn rejects_invalid_input() {
        let mut analyzer = Analyzer::new(FRAME_SIZE, &TARGETS).unwrap();
        assert!(analyzer.analyze(&[0.0; 8], 48000.0).is_err());
        assert!(analyzer.analyze(&[0.0; FRAME_SIZE], f32::NAN).is_err());
        assert!(analyzer.analyze(&[f32::NAN; FRAME_SIZE], 48000.0).is_err());
        assert!(analyzer.analyze(&[0.0; FRAME_SIZE], 0.0).is_err());
    }
}
