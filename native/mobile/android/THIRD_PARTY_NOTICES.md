# Android third-party assets

## sherpa-onnx Android runtime

- Version: 2.0.1
- Upstream: https://github.com/k2-fsa/sherpa-onnx
- Release asset: `sherpa-onnx-2.0.1.aar`
- SHA-256: `a8d09d1d32f3eb8520482c6d3d43fae674681c5b050385967c70a3c2c9bf0ee7`
- License: Apache-2.0 (upstream project)

## WeSpeaker English speaker embedding model

- Model: `wespeaker_en_voxceleb_resnet34.onnx`
- Runtime: WeSpeaker ResNet34, English VoxCeleb release exported for sherpa-onnx
- Upstream model collection: https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models
- Model card: https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34
- SHA-256: `5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94`
- Model card declares Apache-2.0. The upstream WeSpeaker project documents that pretrained weights also follow the corresponding dataset license; VoxCeleb data is CC BY 4.0. See https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md.

The speaker model and runtime operate locally. Raw samples are discarded after embedding extraction. The resulting encrypted embedding remains on the enrolling Android device. Voice match only creates an owner-candidate signal and cannot authenticate or grant capabilities. The initial similarity threshold is provisional and must be validated against physical-device owner/guest recordings before any presence automation relies on it.
