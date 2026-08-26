cmake_minimum_required(VERSION 3.20)
project(libdave_node_binding_probe LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(OpenSSL REQUIRED)
find_package(MLSPP CONFIG REQUIRED)

add_library(libdave_node_probe MODULE probe.cpp)
target_include_directories(
  libdave_node_probe
  PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/../dependency-probes/libdave/cpp/includes"
)
target_link_libraries(
  libdave_node_probe
  PRIVATE
    "${LIBDAVE_STATIC_LIBRARY}"
    OpenSSL::Crypto
    MLSPP::mlspp
    ${CMAKE_DL_LIBS}
)
set_target_properties(
  libdave_node_probe
  PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    MSVC_RUNTIME_LIBRARY "MultiThreaded"
)
