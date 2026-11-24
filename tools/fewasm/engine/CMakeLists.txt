cmake_minimum_required(VERSION 3.20)
project(fe LANGUAGES C VERSION 0.1.0)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

option(FE_ENABLE_PROFILE     "Per-op timing instrumentation"            OFF)
option(FE_USE_ACCURATE_POLY  "Use Remez polys in shared 128-bit/NEON transcendentals" OFF)
option(FE_BUILD_TESTS        "Build test and benchmark runners"          ON)
include(CTest)

# This tree carries the wasm32 tier only. The ARM and x86 tiers were
# removed; they live in the upstream project this engine was ported from.
string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" _proc)
if(NOT (_proc MATCHES "wasm32|wasm" OR CMAKE_SYSTEM_NAME STREQUAL "Emscripten"))
    message(FATAL_ERROR
        "fe builds for wasm32 only. "
        "Detected CMAKE_SYSTEM_PROCESSOR='${CMAKE_SYSTEM_PROCESSOR}'.")
endif()
set(FE_ARCH "wasm32")

message(STATUS "fe ${PROJECT_VERSION}")
message(STATUS "  arch     : ${FE_ARCH}")
message(STATUS "  dispatch : runtime (cpu-feature detection at fe_init)")

# Baseline flags. Per-tier -march flags are applied per-source below.
set(FE_FLAGS_COMMON
    -O3 -Wall -Wextra -Wno-unused-parameter
    -fno-math-errno -fno-trapping-math -ffinite-math-only
    -fmerge-all-constants -fno-exceptions
    -fno-stack-protector -fvisibility=hidden
    -DNDEBUG)
# Intentionally NOT setting -ffast-math. The runtime uses fixed SIMD
# polynomial approximations and a finite-input contract; cross-tier byte-id is
# guarded by the regression tests rather than relying on libm equivalence.
# -fno-stack-protector: kernels are leaf-ish hot paths; canary load+check
#   per call is dead weight (also we just sized down the big stack arrays
#   that would have triggered the canary heuristic anyway).
# -fvisibility=hidden: only the fe_* public ABI is annotated; internal
#   symbols stay TU-local for tighter codegen + fewer GOT lookups.
#
# LTO: opt-in (-DFE_ENABLE_LTO=ON). Measured neutral-to-slightly-negative
# on the streaming GRU/attention hot path on M2: the function-pointer
# dispatch (fe_qgemm_ops.*) is already collapsed to a direct call per tier
# inside the engine, so there's no leftover indirect call for LTO to
# devirtualize, and the resulting cross-TU inlining sometimes regresses
# register allocation in the hot I8MM kernels.
option(FE_ENABLE_LTO "Enable interprocedural optimization (LTO)" OFF)

# PGO: two-stage build. Pass 1 emits instrumentation
# (-DFE_PGO=generate, build, run with representative workload to produce
# default.profraw). Pass 2 consumes the merged profile
# (-DFE_PGO=use -DFE_PGO_PROFILE=/abs/path/to/merged.profdata).
set(FE_PGO "" CACHE STRING "PGO mode: '' | generate | use")
set(FE_PGO_PROFILE "" CACHE PATH "Merged .profdata for FE_PGO=use")
if(FE_PGO STREQUAL "generate")
    set(FE_PGO_FLAGS -fprofile-generate=${CMAKE_BINARY_DIR}/pgo-raw)
    list(APPEND FE_FLAGS_COMMON ${FE_PGO_FLAGS})
    link_libraries(${FE_PGO_FLAGS})
    message(STATUS "  PGO      : generate (raw → ${CMAKE_BINARY_DIR}/pgo-raw)")
elseif(FE_PGO STREQUAL "use")
    if(NOT EXISTS "${FE_PGO_PROFILE}")
        message(FATAL_ERROR "FE_PGO=use requires -DFE_PGO_PROFILE=<merged.profdata> (got '${FE_PGO_PROFILE}')")
    endif()
    list(APPEND FE_FLAGS_COMMON -fprofile-use=${FE_PGO_PROFILE} -Wno-profile-instr-out-of-date -Wno-profile-instr-unprofiled)
    message(STATUS "  PGO      : use (${FE_PGO_PROFILE})")
endif()
if(FE_ENABLE_LTO)
    include(CheckIPOSupported)
    check_ipo_supported(RESULT FE_LTO_OK OUTPUT FE_LTO_ERR)
    if(FE_LTO_OK)
        set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
        message(STATUS "  LTO      : enabled")
    else()
        message(STATUS "  LTO      : requested but unavailable (${FE_LTO_ERR})")
    endif()
else()
    message(STATUS "  LTO      : off (FE_ENABLE_LTO=ON to enable)")
endif()

if(FE_ENABLE_PROFILE)
    add_compile_definitions(FE_ENABLE_PROFILE)
endif()
if(FE_USE_ACCURATE_POLY)
    add_compile_definitions(FE_USE_ACCURATE_POLY)
endif()

# Engine library. One tier: wasm32 with SIMD128, which is part of the target.
file(GLOB FE_SRC_TOP CONFIGURE_DEPENDS src/*.c)
file(GLOB FE_SRC_NN CONFIGURE_DEPENDS src/nn/*.c)
file(GLOB FE_SRC_QGEMM CONFIGURE_DEPENDS src/qgemm/*.c)
file(GLOB FE_SRC_WINO CONFIGURE_DEPENDS src/winograd/*.c)
# FFT: the wasm tier TU. There is no scalar runtime tier.
set(FE_SRC ${FE_SRC_TOP} ${FE_SRC_NN} ${FE_SRC_QGEMM} ${FE_SRC_WINO})
file(GLOB FE_SRC_WASM CONFIGURE_DEPENDS src/qgemm/wasm/*.c)
list(APPEND FE_SRC ${FE_SRC_WASM}
                   src/fft/fft_wasm.c)

add_library(fe STATIC ${FE_SRC})
target_include_directories(fe
    PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src
            ${CMAKE_CURRENT_SOURCE_DIR}/src/internal)
if(NOT MSVC AND NOT WIN32)
    target_link_libraries(fe PUBLIC m)
endif()
target_compile_options(fe PRIVATE ${FE_FLAGS_COMMON})

# Test runners (fe_run_file: end-to-end inference; fe_test_cross_tier: bit-id).
if(FE_BUILD_TESTS)
    file(GLOB TEST_SRC CONFIGURE_DEPENDS tests/*.c)
    foreach(T ${TEST_SRC})
        get_filename_component(TNAME ${T} NAME_WE)
        add_executable(${TNAME} ${T})
        target_include_directories(${TNAME} PRIVATE
            ${CMAKE_CURRENT_SOURCE_DIR}/src
            ${CMAKE_CURRENT_SOURCE_DIR}/src/internal)
        target_link_libraries(${TNAME} PRIVATE fe)
        target_compile_options(${TNAME} PRIVATE ${FE_FLAGS_COMMON})
    endforeach()

    if(BUILD_TESTING)
        set(FE_TEST_WEIGHTS "${CMAKE_CURRENT_SOURCE_DIR}/weights/fe.q8")
        set(FE_TEST_AUDIO   "${CMAKE_CURRENT_SOURCE_DIR}/testaudio/street_5dB.f32")
        if(EXISTS "${FE_TEST_WEIGHTS}" AND EXISTS "${FE_TEST_AUDIO}")
            add_test(NAME fe_cross_tier_smoke
                     COMMAND fe_test_cross_tier
                             "${FE_TEST_WEIGHTS}" "${FE_TEST_AUDIO}" 32)
            add_test(NAME fe_run_file_smoke
                     COMMAND fe_run_file
                             "${FE_TEST_WEIGHTS}" "${FE_TEST_AUDIO}"
                             "${CMAKE_CURRENT_BINARY_DIR}/fe_smoke.wav" 32)
            set_tests_properties(fe_run_file_smoke PROPERTIES
                                 ENVIRONMENT "FE_RT=0")
        else()
            message(STATUS "  tests    : runners only (weights/testaudio .f32 missing)")
        endif()
    endif()
endif()

include(GNUInstallDirs)
install(TARGETS fe
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR})
install(FILES include/fe.h DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(FILES LICENSE NOTICE DESTINATION ${CMAKE_INSTALL_DOCDIR})
