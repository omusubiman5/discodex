import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Dispatch
import Foundation

func fail(_ message: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

func deviceName(_ id: AudioDeviceID) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioObjectPropertyName,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var value: CFString = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
  return value as String
}

func outputDevice(named expected: String) -> AudioDeviceID? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return nil }
  var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else { return nil }
  return devices.filter { deviceName($0) == expected }.single
}

extension Array {
  var single: Element? { count == 1 ? self[0] : nil }
}

let arguments = CommandLine.arguments
guard arguments.count == 3, arguments[1] == "--device-name", !arguments[2].isEmpty else { fail("invalid arguments", 64) }
let expectedDeviceName = arguments[2]
guard let device = outputDevice(named: expectedDeviceName) else { fail("exact Core Audio output device not found", 65) }

let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
engine.attach(player)
guard let audioUnit = engine.outputNode.audioUnit else { fail("Core Audio output unit unavailable", 66) }
var selectedDevice = device
guard AudioUnitSetProperty(
  audioUnit,
  kAudioOutputUnitProperty_CurrentDevice,
  kAudioUnitScope_Global,
  0,
  &selectedDevice,
  UInt32(MemoryLayout<AudioDeviceID>.size)
) == noErr else { fail("Core Audio output device selection failed", 67) }

guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false) else {
  fail("48 kHz stereo format unavailable", 68)
}
engine.connect(player, to: engine.mainMixerNode, format: format)
do { try engine.start() } catch { fail("Core Audio engine start failed", 69) }
player.play()
FileHandle.standardOutput.write(Data("READY\n".utf8))

let frameCount = 960
let bytesPerChunk = frameCount * 2 * MemoryLayout<Int16>.size
let input = FileHandle.standardInput
let scheduledSlots = DispatchSemaphore(value: 8)
while true {
  let data = try input.read(upToCount: bytesPerChunk) ?? Data()
  if data.isEmpty { break }
  if data.count % 4 != 0 { fail("partial stereo PCM frame", 70) }
  let frames = AVAudioFrameCount(data.count / 4)
  guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { fail("PCM buffer allocation failed", 71) }
  buffer.frameLength = frames
  data.withUnsafeBytes { raw in
    let source = raw.bindMemory(to: Int16.self)
    guard let left = buffer.floatChannelData?[0], let right = buffer.floatChannelData?[1] else { return }
    for frame in 0..<Int(frames) {
      left[frame] = Float(source[frame * 2]) / 32768.0
      right[frame] = Float(source[frame * 2 + 1]) / 32768.0
    }
  }
  scheduledSlots.wait()
  player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in scheduledSlots.signal() }
}
player.stop()
engine.stop()
