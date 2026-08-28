#include <cstdint>
#include <cstddef>
#ifdef _WIN32
#include <windows.h>
#define NAPI_CALL __cdecl
#define NAPI_EXPORT __declspec(dllexport)
static void* ResolveNodeSymbol(const char* name)
{
  return reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(nullptr), name));
}
#else
#include <dlfcn.h>
#define NAPI_CALL
#define NAPI_EXPORT __attribute__((visibility("default")))
static void* ResolveNodeSymbol(const char* name)
{
  return dlsym(RTLD_DEFAULT, name);
}
#endif
#include <string>
#include <cstdlib>
#include <unordered_map>
#include <vector>
#include <dave/dave.h>

// The feasibility probe intentionally declares only the two ABI boundaries it
// needs. Production code will use the official Node-API and libdave headers.
using napi_env = void*;
using napi_value = void*;
using napi_status = int;
using napi_callback_info = void*;
using napi_callback = napi_value(NAPI_CALL*)(napi_env, napi_callback_info);
using napi_create_uint32_fn = napi_status(NAPI_CALL*)(napi_env, std::uint32_t, napi_value*);
using napi_set_named_property_fn = napi_status(NAPI_CALL*)(napi_env, napi_value, const char*, napi_value);
using napi_create_function_fn = napi_status(NAPI_CALL*)(napi_env, const char*, std::size_t, napi_callback, void*, napi_value*);
using napi_get_boolean_fn = napi_status(NAPI_CALL*)(napi_env, bool, napi_value*);
using napi_get_cb_info_fn = napi_status(NAPI_CALL*)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
using napi_get_value_string_utf8_fn = napi_status(NAPI_CALL*)(napi_env, napi_value, char*, size_t, size_t*);
using napi_create_buffer_copy_fn = napi_status(NAPI_CALL*)(napi_env, size_t, const void*, void**, napi_value*);
using napi_get_buffer_info_fn = napi_status(NAPI_CALL*)(napi_env, napi_value, void**, size_t*);
using napi_get_value_uint32_fn = napi_status(NAPI_CALL*)(napi_env, napi_value, std::uint32_t*);
using napi_get_array_length_fn = napi_status(NAPI_CALL*)(napi_env, napi_value, std::uint32_t*);
using napi_get_element_fn = napi_status(NAPI_CALL*)(napi_env, napi_value, std::uint32_t, napi_value*);
using napi_get_null_fn = napi_status(NAPI_CALL*)(napi_env, napi_value*);
using napi_create_string_utf8_fn = napi_status(NAPI_CALL*)(napi_env, const char*, size_t, napi_value*);

static napi_get_boolean_fn getBoolean = nullptr;
static napi_get_cb_info_fn getCbInfo = nullptr;
static napi_get_value_string_utf8_fn getString = nullptr;
static napi_create_buffer_copy_fn createBufferCopy = nullptr;
static napi_get_buffer_info_fn getBufferInfo = nullptr;
static napi_get_value_uint32_fn getUint32 = nullptr;
static napi_get_array_length_fn getArrayLength = nullptr;
static napi_get_element_fn getElement = nullptr;
static napi_get_null_fn getNull = nullptr;
static napi_create_string_utf8_fn createString = nullptr;
static DAVESessionHandle readySession = nullptr;

struct MediaContext {
  DAVEEncryptorHandle encryptor = nullptr;
  DAVEDecryptorHandle decryptor = nullptr;
  DAVEKeyRatchetHandle encryptRatchet = nullptr;
  DAVEKeyRatchetHandle decryptRatchet = nullptr;
};

static std::unordered_map<std::uint32_t, MediaContext> mediaContexts;

static void NoopDaveLogSink(DAVELoggingSeverity, const char*, int, const char*)
{
  // libdave debug lines can contain MLS/key-package bytes. Product builds keep
  // those bytes inside the native boundary and emit only sanitized counters.
}

static napi_value BooleanResult(napi_env env, bool value)
{
  napi_value result = nullptr;
  if (!getBoolean || getBoolean(env, value, &result) != 0) return nullptr;
  return result;
}

static void DestroyMediaContext(MediaContext& context)
{
  if (context.encryptor) daveEncryptorDestroy(context.encryptor);
  if (context.decryptor) daveDecryptorDestroy(context.decryptor);
  if (context.encryptRatchet) daveKeyRatchetDestroy(context.encryptRatchet);
  if (context.decryptRatchet) daveKeyRatchetDestroy(context.decryptRatchet);
  context = {};
}

static void ClearMedia()
{
  for (auto& entry : mediaContexts) DestroyMediaContext(entry.second);
  mediaContexts.clear();
}

static bool ReadBuffer(napi_env env, napi_value value, const std::uint8_t*& bytes, size_t& length)
{
  void* raw = nullptr;
  if (!getBufferInfo || getBufferInfo(env, value, &raw, &length) != 0 || !raw || length == 0) return false;
  bytes = static_cast<const std::uint8_t*>(raw);
  return true;
}

static napi_value BufferResult(napi_env env, const std::uint8_t* bytes, size_t length)
{
  if (!bytes || length == 0 || !createBufferCopy) return nullptr;
  napi_value result = nullptr;
  void* copied = nullptr;
  return createBufferCopy(env, length, bytes, &copied, &result) == 0 ? result : nullptr;
}

static napi_value NAPI_CALL SessionLifecycle(napi_env env, napi_callback_info)
{
  const auto version = daveMaxSupportedProtocolVersion();
  auto* session = daveSessionCreate(nullptr, nullptr, nullptr, nullptr);
  bool passed = session != nullptr;
  if (session) {
    daveSessionInit(session, version, 1, "1");
    passed = daveSessionGetProtocolVersion(session) == version;
    daveSessionDestroy(session);
  }

  return BooleanResult(env, passed);
}

static napi_value NAPI_CALL SessionOpen(napi_env env, napi_callback_info)
{
  if (readySession) return BooleanResult(env, true);
  const auto version = daveMaxSupportedProtocolVersion();
  readySession = daveSessionCreate(nullptr, nullptr, nullptr, nullptr);
  if (!readySession) return BooleanResult(env, false);
  daveSessionInit(readySession, version, 1, "1");
  if (daveSessionGetProtocolVersion(readySession) != version) {
    daveSessionDestroy(readySession);
    readySession = nullptr;
    return BooleanResult(env, false);
  }
  return BooleanResult(env, true);
}

static napi_value NAPI_CALL SessionClose(napi_env env, napi_callback_info)
{
  ClearMedia();
  if (readySession) {
    daveSessionDestroy(readySession);
    readySession = nullptr;
  }
  return BooleanResult(env, true);
}

static napi_value NAPI_CALL SessionIsOpen(napi_env env, napi_callback_info)
{
  return BooleanResult(env, readySession != nullptr);
}

static bool ReadString(napi_env env, napi_value value, std::string& output)
{
  size_t length = 0;
  if (!getString || getString(env, value, nullptr, 0, &length) != 0 || length == 0) return false;
  output.resize(length);
  size_t copied = 0;
  return getString(env, value, output.data(), length + 1, &copied) == 0 && copied == length;
}

static napi_value NAPI_CALL SessionConfigure(napi_env env, napi_callback_info info)
{
  napi_value args[2]{};
  size_t argc = 2;
  if (!readySession || !getCbInfo || getCbInfo(env, info, &argc, args, nullptr, nullptr) != 0 || argc != 2) return BooleanResult(env, false);
  std::string groupId, userId;
  if (!ReadString(env, args[0], groupId) || !ReadString(env, args[1], userId)) return BooleanResult(env, false);
  char* end = nullptr;
#ifdef _WIN32
  const auto group = _strtoui64(groupId.c_str(), &end, 10);
#else
  const auto group = std::strtoull(groupId.c_str(), &end, 10);
#endif
  if (!end || *end != '\0' || group == 0) return BooleanResult(env, false);
  const auto version = daveMaxSupportedProtocolVersion();
  daveSessionInit(readySession, version, group, userId.c_str());
  return BooleanResult(env, daveSessionGetProtocolVersion(readySession) == version);
}

static napi_value NAPI_CALL SessionSetProtocolVersion(napi_env env, napi_callback_info)
{
  if (!readySession) return BooleanResult(env, false);
  const auto version = daveMaxSupportedProtocolVersion();
  daveSessionSetProtocolVersion(readySession, version);
  return BooleanResult(env, daveSessionGetProtocolVersion(readySession) == version);
}

static napi_value NAPI_CALL SessionKeyPackage(napi_env env, napi_callback_info)
{
  if (!readySession || !createBufferCopy) return nullptr;
  std::uint8_t* bytes = nullptr;
  std::size_t length = 0;
  daveSessionGetMarshalledKeyPackage(readySession, &bytes, &length);
  if (!bytes || length == 0) { daveFree(bytes); return nullptr; }
  napi_value result = nullptr;
  void* copied = nullptr;
  const auto status = createBufferCopy(env, length, bytes, &copied, &result);
  daveFree(bytes);
  return status == 0 ? result : nullptr;
}

static napi_value NAPI_CALL SessionSetExternalSender(napi_env env, napi_callback_info info)
{
  napi_value arg{};
  size_t argc = 1;
  if (!readySession || !getCbInfo || getCbInfo(env, info, &argc, &arg, nullptr, nullptr) != 0 || argc != 1) return BooleanResult(env, false);
  void* bytes = nullptr;
  size_t length = 0;
  if (!getBufferInfo || getBufferInfo(env, arg, &bytes, &length) != 0 || !bytes || length == 0) return BooleanResult(env, false);
  daveSessionSetExternalSender(readySession, static_cast<const std::uint8_t*>(bytes), length);
  return BooleanResult(env, true);
}

static bool ReadUserIds(napi_env env, napi_value value, std::vector<std::string>& storage, std::vector<const char*>& pointers)
{
  std::uint32_t length = 0;
  if (!getArrayLength || getArrayLength(env, value, &length) != 0 || length == 0) return false;
  storage.reserve(length);
  for (std::uint32_t index = 0; index < length; ++index) {
    napi_value element = nullptr;
    std::string userId;
    if (!getElement || getElement(env, value, index, &element) != 0 || !ReadString(env, element, userId)) return false;
    storage.push_back(std::move(userId));
  }
  pointers.reserve(storage.size());
  for (const auto& userId : storage) pointers.push_back(userId.c_str());
  return true;
}

static napi_value NAPI_CALL SessionProcessProposals(napi_env env, napi_callback_info info)
{
  napi_value args[2]{};
  size_t argc = 2;
  if (!readySession || !getCbInfo || getCbInfo(env, info, &argc, args, nullptr, nullptr) != 0 || argc != 2) return nullptr;
  const std::uint8_t* proposals = nullptr;
  size_t proposalLength = 0;
  if (!ReadBuffer(env, args[0], proposals, proposalLength)) return nullptr;
  std::vector<std::string> storage;
  std::vector<const char*> ids;
  if (!ReadUserIds(env, args[1], storage, ids)) return nullptr;
  std::uint8_t* output = nullptr;
  size_t outputLength = 0;
  daveSessionProcessProposals(readySession, proposals, proposalLength, ids.data(), ids.size(), &output, &outputLength);
  if (!output || outputLength == 0) {
    daveFree(output);
    napi_value empty = nullptr;
    return getNull && getNull(env, &empty) == 0 ? empty : nullptr;
  }
  napi_value result = BufferResult(env, output, outputLength);
  daveFree(output);
  return result;
}

static napi_value NAPI_CALL SessionProcessCommit(napi_env env, napi_callback_info info)
{
  napi_value arg{};
  size_t argc = 1;
  if (!readySession || !getCbInfo || getCbInfo(env, info, &argc, &arg, nullptr, nullptr) != 0 || argc != 1) return nullptr;
  const std::uint8_t* commit = nullptr;
  size_t length = 0;
  if (!ReadBuffer(env, arg, commit, length)) return nullptr;
  const auto result = daveSessionProcessCommit(readySession, commit, length);
  const char* status = "failed";
  if (result) {
    status = daveCommitResultIsFailed(result) ? "failed" : (daveCommitResultIsIgnored(result) ? "ignored" : "accepted");
    daveCommitResultDestroy(result);
  }
  napi_value value = nullptr;
  return createString && createString(env, status, static_cast<size_t>(-1), &value) == 0 ? value : nullptr;
}

static napi_value NAPI_CALL SessionProcessWelcome(napi_env env, napi_callback_info info)
{
  napi_value args[2]{};
  size_t argc = 2;
  if (!readySession || !getCbInfo || getCbInfo(env, info, &argc, args, nullptr, nullptr) != 0 || argc != 2) return nullptr;
  const std::uint8_t* welcome = nullptr;
  size_t length = 0;
  std::vector<std::string> storage;
  std::vector<const char*> ids;
  if (!ReadBuffer(env, args[0], welcome, length) || !ReadUserIds(env, args[1], storage, ids)) return BooleanResult(env, false);
  const auto result = daveSessionProcessWelcome(readySession, welcome, length, ids.data(), ids.size());
  if (!result) return BooleanResult(env, false);
  daveWelcomeResultDestroy(result);
  // The C API reports Welcome failure by returning no result handle.
  return BooleanResult(env, true);
}

static napi_value NAPI_CALL SessionReset(napi_env env, napi_callback_info)
{
  if (!readySession) return BooleanResult(env, false);
  ClearMedia();
  daveSessionReset(readySession);
  return BooleanResult(env, true);
}

static napi_value NAPI_CALL SessionSelectMediaRatchet(napi_env env, napi_callback_info info)
{
  napi_value args[2]{};
  size_t argc = 2;
  if (!readySession || !getCbInfo || !getUint32 || getCbInfo(env, info, &argc, args, nullptr, nullptr) != 0 || argc != 2) return BooleanResult(env, false);
  std::string userId;
  std::uint32_t ssrc = 0;
  if (!ReadString(env, args[0], userId) || getUint32(env, args[1], &ssrc) != 0 || ssrc == 0) return BooleanResult(env, false);
  auto existing = mediaContexts.find(ssrc);
  if (existing != mediaContexts.end()) {
    DestroyMediaContext(existing->second);
    mediaContexts.erase(existing);
  }
  MediaContext context;
  context.encryptRatchet = daveSessionGetKeyRatchet(readySession, userId.c_str());
  context.decryptRatchet = daveSessionGetKeyRatchet(readySession, userId.c_str());
  context.encryptor = daveEncryptorCreate();
  context.decryptor = daveDecryptorCreate();
  if (!context.encryptRatchet || !context.decryptRatchet || !context.encryptor || !context.decryptor) {
    DestroyMediaContext(context);
    return BooleanResult(env, false);
  }
  daveEncryptorSetKeyRatchet(context.encryptor, context.encryptRatchet);
  daveEncryptorAssignSsrcToCodec(context.encryptor, ssrc, DAVE_CODEC_OPUS);
  daveDecryptorTransitionToKeyRatchet(context.decryptor, context.decryptRatchet);
  if (!daveEncryptorHasKeyRatchet(context.encryptor)) {
    DestroyMediaContext(context);
    return BooleanResult(env, false);
  }
  mediaContexts.emplace(ssrc, context);
  return BooleanResult(env, true);
}

static napi_value NAPI_CALL SessionEncryptOpus(napi_env env, napi_callback_info info)
{
  napi_value args[2]{};
  size_t argc = 2;
  if (!getCbInfo || !getUint32 || getCbInfo(env, info, &argc, args, nullptr, nullptr) != 0 || argc != 2) return nullptr;
  const std::uint8_t* frame = nullptr;
  size_t length = 0;
  std::uint32_t ssrc = 0;
  if (!ReadBuffer(env, args[1], frame, length) || getUint32(env, args[0], &ssrc) != 0 || ssrc == 0) return nullptr;
  const auto context = mediaContexts.find(ssrc);
  if (context == mediaContexts.end() || !context->second.encryptor) return nullptr;
  const auto encryptor = context->second.encryptor;
  std::vector<std::uint8_t> output(daveEncryptorGetMaxCiphertextByteSize(encryptor, DAVE_MEDIA_TYPE_AUDIO, length));
  size_t written = 0;
  if (output.empty() || daveEncryptorEncrypt(encryptor, DAVE_MEDIA_TYPE_AUDIO, ssrc, frame, length, output.data(), output.size(), &written) != DAVE_ENCRYPTOR_RESULT_CODE_SUCCESS) return nullptr;
  return BufferResult(env, output.data(), written);
}

static napi_value NAPI_CALL SessionDecryptOpus(napi_env env, napi_callback_info info)
{
  napi_value args[2]{};
  size_t argc = 2;
  if (!getCbInfo || !getUint32 || getCbInfo(env, info, &argc, args, nullptr, nullptr) != 0 || argc != 2) return nullptr;
  const std::uint8_t* frame = nullptr;
  size_t length = 0;
  std::uint32_t ssrc = 0;
  if (getUint32(env, args[0], &ssrc) != 0 || ssrc == 0 || !ReadBuffer(env, args[1], frame, length)) return nullptr;
  const auto context = mediaContexts.find(ssrc);
  if (context == mediaContexts.end() || !context->second.decryptor) return nullptr;
  const auto decryptor = context->second.decryptor;
  std::vector<std::uint8_t> output(daveDecryptorGetMaxPlaintextByteSize(decryptor, DAVE_MEDIA_TYPE_AUDIO, length));
  size_t written = 0;
  if (output.empty() || daveDecryptorDecrypt(decryptor, DAVE_MEDIA_TYPE_AUDIO, frame, length, output.data(), output.size(), &written) != DAVE_DECRYPTOR_RESULT_CODE_SUCCESS) return nullptr;
  return BufferResult(env, output.data(), written);
}

extern "C" NAPI_EXPORT napi_value napi_register_module_v1(
  napi_env env,
  napi_value exports)
{
  daveSetLogSinkCallback(NoopDaveLogSink);
  const auto createUint32 = reinterpret_cast<napi_create_uint32_fn>(
    ResolveNodeSymbol("napi_create_uint32"));
  const auto setNamedProperty = reinterpret_cast<napi_set_named_property_fn>(
    ResolveNodeSymbol("napi_set_named_property"));
  const auto createFunction = reinterpret_cast<napi_create_function_fn>(
    ResolveNodeSymbol("napi_create_function"));
  getBoolean = reinterpret_cast<napi_get_boolean_fn>(
    ResolveNodeSymbol("napi_get_boolean"));
  getCbInfo = reinterpret_cast<napi_get_cb_info_fn>(ResolveNodeSymbol("napi_get_cb_info"));
  getString = reinterpret_cast<napi_get_value_string_utf8_fn>(ResolveNodeSymbol("napi_get_value_string_utf8"));
  createBufferCopy = reinterpret_cast<napi_create_buffer_copy_fn>(ResolveNodeSymbol("napi_create_buffer_copy"));
  getBufferInfo = reinterpret_cast<napi_get_buffer_info_fn>(ResolveNodeSymbol("napi_get_buffer_info"));
  getUint32 = reinterpret_cast<napi_get_value_uint32_fn>(ResolveNodeSymbol("napi_get_value_uint32"));
  getArrayLength = reinterpret_cast<napi_get_array_length_fn>(ResolveNodeSymbol("napi_get_array_length"));
  getElement = reinterpret_cast<napi_get_element_fn>(ResolveNodeSymbol("napi_get_element"));
  getNull = reinterpret_cast<napi_get_null_fn>(ResolveNodeSymbol("napi_get_null"));
  createString = reinterpret_cast<napi_create_string_utf8_fn>(ResolveNodeSymbol("napi_create_string_utf8"));
  if (!createUint32 || !setNamedProperty || !createFunction || !getBoolean || !getCbInfo || !getString || !createBufferCopy || !getBufferInfo || !getUint32 || !getArrayLength || !getElement || !getNull || !createString) return nullptr;

  const auto version = daveMaxSupportedProtocolVersion();
  if (version == 0) return nullptr;

  napi_value jsVersion = nullptr;
  if (createUint32(env, version, &jsVersion) != 0) return nullptr;
  if (setNamedProperty(env, exports, "maxProtocolVersion", jsVersion) != 0) return nullptr;

  napi_value lifecycle = nullptr;
  if (createFunction(env, "sessionLifecycle", 16, SessionLifecycle, nullptr, &lifecycle) != 0) return nullptr;
  if (setNamedProperty(env, exports, "sessionLifecycle", lifecycle) != 0) return nullptr;

  napi_value sessionOpen = nullptr;
  if (createFunction(env, "sessionOpen", 11, SessionOpen, nullptr, &sessionOpen) != 0) return nullptr;
  if (setNamedProperty(env, exports, "sessionOpen", sessionOpen) != 0) return nullptr;

  napi_value sessionClose = nullptr;
  if (createFunction(env, "sessionClose", 12, SessionClose, nullptr, &sessionClose) != 0) return nullptr;
  if (setNamedProperty(env, exports, "sessionClose", sessionClose) != 0) return nullptr;

  napi_value sessionIsOpen = nullptr;
  if (createFunction(env, "sessionIsOpen", 13, SessionIsOpen, nullptr, &sessionIsOpen) != 0) return nullptr;
  if (setNamedProperty(env, exports, "sessionIsOpen", sessionIsOpen) != 0) return nullptr;

#define EXPORT_FN(jsName, callback) do { napi_value fn = nullptr; if (createFunction(env, jsName, sizeof(jsName)-1, callback, nullptr, &fn) != 0) return nullptr; if (setNamedProperty(env, exports, jsName, fn) != 0) return nullptr; } while (0)
  EXPORT_FN("sessionConfigure", SessionConfigure);
  EXPORT_FN("sessionSetProtocolVersion", SessionSetProtocolVersion);
  EXPORT_FN("sessionKeyPackage", SessionKeyPackage);
  EXPORT_FN("sessionSetExternalSender", SessionSetExternalSender);
  EXPORT_FN("sessionProcessProposals", SessionProcessProposals);
  EXPORT_FN("sessionProcessCommit", SessionProcessCommit);
  EXPORT_FN("sessionProcessWelcome", SessionProcessWelcome);
  EXPORT_FN("sessionReset", SessionReset);
  EXPORT_FN("sessionSelectMediaRatchet", SessionSelectMediaRatchet);
  EXPORT_FN("sessionEncryptOpus", SessionEncryptOpus);
  EXPORT_FN("sessionDecryptOpus", SessionDecryptOpus);
#undef EXPORT_FN
  return exports;
}
