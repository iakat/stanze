/*
 * fe_config.h -- pick the compile-time model size for this build.
 *
 * One build is one model tier: the engine keeps its state in globals and
 * every shape is a compile-time constant, so a tier is chosen at compile
 * time with -DFE_TIER_BASE, -DFE_TIER_SMALL or -DFE_TIER_MEDIUM (default).
 *
 * The public frame size (fe.h FE_FRAME_SIZE) is the tier's hop size; the
 * build script passes -DFE_FRAME_SIZE=512 for the two 512-hop tiers.
 */
#ifndef FE_CONFIG_H
#define FE_CONFIG_H

#if defined(FE_TIER_BASE)
#include "fe_config_base.h"
#elif defined(FE_TIER_SMALL)
#include "fe_config_small.h"
#else
#include "fe_config_medium.h"
#endif

#endif /* FE_CONFIG_H */
