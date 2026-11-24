// Per-op timing instrumentation. Active only when FE_ENABLE_PROFILE
// is defined (CMake option); otherwise FE_TIME macros expand to no-ops.
#ifdef FE_ENABLE_PROFILE

#include "fe_profile.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#  include <windows.h>
#else
#  include <time.h>
#endif

#define FE_PROF_MAX 128

typedef struct {
    const char *name;
    double total_us;
    double max_us;
    int    calls;
    unsigned long long macs;
} fe_op_stat;

const char *fe_prof_stack[8];
int         fe_prof_depth;

static fe_op_stat g_stats[FE_PROF_MAX];
static int        g_n = 0;

double fe_now_us(void) {
#if defined(_WIN32)
    static LARGE_INTEGER freq = {0};
    if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
    LARGE_INTEGER ctr; QueryPerformanceCounter(&ctr);
    return (double)ctr.QuadPart * 1.0e6 / (double)freq.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1.0e6 + (double)ts.tv_nsec / 1.0e3;
#endif
}

void fe_profile_record(const char *name, double us) {
    /* Lookup by pointer identity (we pass string literals -> safe).         */
    for (int i = 0; i < g_n; ++i) {
        if (g_stats[i].name == name) {
            g_stats[i].total_us += us;
            if (us > g_stats[i].max_us) g_stats[i].max_us = us;
            g_stats[i].calls++;
            return;
        }
    }
    if (g_n < FE_PROF_MAX) {
        g_stats[g_n].name     = name;
        g_stats[g_n].total_us = us;
        g_stats[g_n].max_us   = us;
        g_stats[g_n].calls    = 1;
        g_stats[g_n].macs     = 0;
        g_n++;
    }
}

void fe_profile_mac(unsigned long long macs) {
    if (fe_prof_depth <= 0) return;
    const char *name = fe_prof_stack[(fe_prof_depth - 1) & 7];
    for (int i = 0; i < g_n; ++i) {
        if (g_stats[i].name == name) { g_stats[i].macs += macs; return; }
    }
}

void fe_profile_reset(void) {
    g_n = 0;
}

static int cmp_stat_desc(const void *a, const void *b) {
    double ta = ((const fe_op_stat *)a)->total_us;
    double tb = ((const fe_op_stat *)b)->total_us;
    if (ta < tb) return  1;
    if (ta > tb) return -1;
    return 0;
}

void fe_profile_dump(int num_frames) {
    if (g_n == 0 || num_frames <= 0) {
        fprintf(stderr, "(no profile data)\n");
        return;
    }

    /* Sort descending by total time. */
    fe_op_stat sorted[FE_PROF_MAX];
    memcpy(sorted, g_stats, sizeof(fe_op_stat) * (size_t)g_n);
    /* Cast for qsort */
    qsort(sorted, (size_t)g_n, sizeof(fe_op_stat),
          (int (*)(const void *, const void *))cmp_stat_desc);

    double sum = 0.0;
    for (int i = 0; i < g_n; ++i) sum += sorted[i].total_us;

    fprintf(stderr, "\n=== fe per-op profile (%d frames) ===\n", num_frames);
    fprintf(stderr, "%-30s %10s %10s %10s %8s %9s %8s\n",
            "op", "total ms", "us/frame", "max us", "share", "MMAC/fr", "GMAC/s");
    fprintf(stderr,
            "-------------------------------------------------------------------------\n");
    for (int i = 0; i < g_n; ++i) {
        const fe_op_stat *s = &sorted[i];
        const double mf = (double)s->macs / (double)num_frames / 1e6;
        const double gs = (s->total_us > 0.0)
            ? (double)s->macs / (s->total_us * 1000.0) : 0.0;
        fprintf(stderr, "%-30s %10.2f %10.2f %10.2f %7.1f%% %9.2f %8.2f\n",
                s->name,
                s->total_us / 1000.0,
                s->total_us / (double)num_frames,
                s->max_us,
                100.0 * s->total_us / sum,
                mf, gs);
    }
    fprintf(stderr,
            "-------------------------------------------------------------------------\n");
    fprintf(stderr, "%-30s %10.2f %10.2f\n", "TOTAL",
            sum / 1000.0,
            sum / (double)num_frames);
}

#endif /* FE_ENABLE_PROFILE */
