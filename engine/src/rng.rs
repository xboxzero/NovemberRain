/// Small xorshift32 generator: deterministic, allocation free, good enough for visuals and noise.
#[derive(Clone, Copy)]
pub struct Rng(pub u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(if seed == 0 { 0x9E37_79B9 } else { seed })
    }
    #[inline]
    pub fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in 0..1
    #[inline]
    pub fn f(&mut self) -> f32 {
        (self.next() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
    /// Uniform in -1..1
    #[inline]
    pub fn s(&mut self) -> f32 {
        self.f() * 2.0 - 1.0
    }
    #[inline]
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
}
